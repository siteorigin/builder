/**
 * Issue 588: llms.txt, llms-full.txt and the Markdown copies of pages and entries, for AI agents. They list only the
 * documents search engines may list (published and not noindex), say what each one shows as clean Markdown, and the
 * pages link to their copies.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { InstanceNode, ProjectState, RichText } from '@shared/types';
import { generateProject, pageFile, entryFile } from '@generator/index';
import { GenerationCache } from '@generator/cache';
import { documentMarkdown, generateLlmsTxt } from '@generator/llms';
import { agentDiscovery } from '@shared/llms';
import { validateRoute } from '@shared/routes';
import { entryRoute } from '@shared/collections';
import { runSeoAudit } from '@engine/seo-audit';
import { applyOperations } from '@engine/apply';
import { heldAsMedia } from '../../src/main/project/versions';
import { ProjectSession } from '../../src/main/project/session';
import { projectSummary } from '../../src/agent/context';
import { run, seoSite } from './fixtures/seo-site';
import { markdownDesigns } from './fixtures/llms-designs';

const SECRET = 'PRIVATE-SENTINEL-7f3a';

const discovery = (s: ProjectState, on = true) => run(s, { type: 'site.update', llmsFull: on, markdownMirrors: on });
const files = (s: ProjectState) => generateProject(s);
const llmsTxt = (s: ProjectState) => files(s).get('static/llms.txt');
const discoveryFiles = (s: ProjectState) => [...files(s).keys()].filter((p) => /^static\/(llms(-full)?\.txt|(.*\/)?index\.html\.md)$/.test(p)).sort();
/** Place a catalogue component (by its component ID) or one of the project's own designs (by its definition ID). */
const insert = (s: ProjectState, pageId: string, component: string, props: Record<string, unknown>) => {
  const which = s.components[component]?.owner === 'project' ? { definitionId: component } : { componentId: component };
  const r = applyOperations(s, [{ type: 'node.insert', owner: { kind: 'page', id: pageId }, ...which, props } as never]);
  return { state: r.state, nodeId: r.results[0].nodeId as string };
};
const postRoute = (s: ProjectState) => entryRoute(s.collections.posts, s.collections.posts.entries.en_spring)!;
/**
 * The SEO site with the managed designs the Markdown writer is read through. Foundation's sections are code
 * components, whose words the writer cannot know (generator/markdown.ts), so what it makes of headings, rich text,
 * lists, quotes, buttons, cards and feeds is shown on designs of the project's own.
 */
const designedSite = () => {
  const site = seoSite();
  return { ...site, d: markdownDesigns(site.state) };
};

describe('llms.txt', () => {
  it('lists the published, indexable pages and entries with their own descriptions, under the site’s name and summary', () => {
    const { state } = seoSite();
    expect(agentDiscovery(state.site)).toEqual({ llmsTxt: true, llmsFull: false, markdownMirrors: false, summary: state.site.description });
    expect(llmsTxt(state)).toBe(
      [
        '# Riverside Studio',
        '',
        '> A pottery studio by the river, with classes for beginners and a shop of handmade work.',
        '',
        '## Pages',
        '',
        '- [Home](https://example.com/studio/): Pottery classes for beginners and a shop of handmade bowls, cups and plates, by the river in town.',
        '- [Services](https://example.com/studio/services/): Weekly wheel classes, private lessons and commissioned tableware made to order in the studio.',
        '',
        `## ${state.collections.posts.settings.name}`,
        '',
        `- [Spring pottery classes](https://example.com/studio${postRoute(state)}): Spring wheel classes open for bookings: six weeks of throwing, trimming and glazing.`,
        ''
      ].join('\n')
    );
  });

  it('never lists drafts or noindex pages and entries, or anything of them', () => {
    const { state, services } = seoSite();
    let s = run(
      state,
      { type: 'page.update', pageId: services, noindex: true },
      { type: 'page.create', pageId: 'pg_secret', title: `Draft ${SECRET}`, route: '/launch/' },
      { type: 'page.update', pageId: 'pg_secret', draft: true, description: SECRET },
      { type: 'entry.create', collectionId: 'posts', entryId: 'en_draft', title: `Unpublished ${SECRET}`, draft: true, excerpt: SECRET }
    );
    s = discovery(s);
    const text = llmsTxt(s)!;
    expect(text).not.toContain('Services');
    expect(text).not.toContain(SECRET);
    expect(text).toContain('Spring pottery classes');
    // No copy of the draft or of the noindex page, and nothing of them in the full text.
    const out = files(s);
    expect(discoveryFiles(s)).toEqual(['static/index.html.md', 'static/llms-full.txt', 'static/llms.txt', `static${postRoute(s)}index.html.md`].sort());
    for (const p of discoveryFiles(s)) expect(out.get(p)).not.toContain(SECRET);
    expect(out.get('static/llms-full.txt')).not.toContain('Weekly wheel classes');
  });

  it('is turned off by the author, and its full text and copies are only written when asked for', () => {
    const { state } = seoSite();
    expect(discoveryFiles(state)).toEqual(['static/llms.txt']);
    const off = run(state, { type: 'site.update', llmsTxt: false });
    expect(off.site.llmsTxt).toBe(false);
    expect(discoveryFiles(off)).toEqual([]);
    // The copies and the full text stand on their own, and each without the other.
    expect(discoveryFiles(discovery(off))).toEqual(['static/index.html.md', 'static/llms-full.txt', 'static/services/index.html.md', `static${postRoute(state)}index.html.md`].sort());
    expect(discoveryFiles(run(state, { type: 'site.update', llmsFull: true }))).toEqual(['static/llms-full.txt', 'static/llms.txt']);
    expect(discoveryFiles(run(state, { type: 'site.update', markdownMirrors: true }))).toEqual(['static/index.html.md', 'static/llms.txt', 'static/services/index.html.md', `static${postRoute(state)}index.html.md`].sort());
    expect(llmsTxt(run(state, { type: 'site.update', markdownMirrors: true }))).not.toContain('llms-full.txt');
    expect(llmsTxt(run(state, { type: 'site.update', llmsFull: true }))).toContain('- [Services](https://example.com/studio/services/): ');
  });

  it('links to the Markdown copies and the full text when the site writes them', () => {
    const s = discovery(seoSite().state);
    const text = llmsTxt(s)!;
    expect(text).toContain('The full text of every page and post listed here is in [llms-full.txt](https://example.com/studio/llms-full.txt).');
    expect(text).toContain('- [Home](https://example.com/studio/index.html.md): ');
    expect(text).toContain('- [Services](https://example.com/studio/services/index.html.md): ');
    expect(text).toContain(`- [Spring pottery classes](https://example.com/studio${postRoute(s)}index.html.md): `);
  });

  it('writes links relative to each file without a public URL, so they hold in any folder', () => {
    let s = run(discovery(seoSite().state), { type: 'site.update', baseUrl: '' });
    s = run(s, { type: 'page.update', pageId: s.site.homePageId, description: '' });
    const out = files(s);
    expect(out.get('static/llms.txt')).toContain('- [Services](./services/index.html.md): ');
    expect(out.get('static/llms.txt')).toContain('[llms-full.txt](./llms-full.txt)');
    expect(out.get('static/services/index.html.md')).toContain('URL: ../services/');
    expect(out.get('static/llms-full.txt')).toContain('URL: ./services/');
    // Two folders down, a post's copy climbs both.
    const depth = postRoute(s).split('/').filter(Boolean).length;
    expect(depth).toBe(2);
    expect(out.get(`static${postRoute(s)}index.html.md`)).toContain(`URL: ../../${postRoute(s).slice(1)}`);
  });

  it('opens with the author’s summary, and writes titles and words that look like Markdown literally', () => {
    const { state, services } = seoSite();
    const s = run(state, { type: 'site.update', llmsSummary: '  Hand-thrown  pottery\nby the river.  ' }, { type: 'page.update', pageId: services, title: 'Classes [new]\n# and *more*' });
    expect(s.site.llmsSummary).toBe('Hand-thrown pottery by the river.');
    const text = llmsTxt(s)!;
    expect(text).toContain('> Hand-thrown pottery by the river.\n');
    expect(text).toContain('- [Classes \\[new\\] # and \\*more\\*](https://example.com/studio/services/): ');
    // Exactly one line per document: nothing a title holds starts a line of its own.
    expect(text.split('\n').filter((l) => l.startsWith('- ['))).toHaveLength(3);
    expect(run(s, { type: 'site.update', llmsSummary: '' }).site.llmsSummary).toBeUndefined();
    // A summary or description that starts like a heading or a list stays words in its quote.
    for (const [summary, quoted] of [['# Release notes', '> \\# Release notes'], ['- First', '> \\- First'], ['1. First', '> 1\\. First'], ['`code` here', '> \\`code\\` here']])
      expect(llmsTxt(run(s, { type: 'site.update', llmsSummary: summary }))).toContain(`\n${quoted}\n`);
  });

  it('writes words that look like Markdown literally in a document, and keeps a line break as a line break', () => {
    const { state, home, d } = designedSite();
    const body: RichText = [
      { type: 'p', spans: [{ text: '## Details' }] },
      { type: 'p', spans: [{ text: '>quoted' }] },
      { type: 'p', spans: [{ text: '1. First\n2) Second\n---' }] },
      { type: 'p', spans: [{ text: '12 River Lane\nTownsville' }] }
    ];
    const s = insert(discovery(state), home, d.text, { heading: '', body }).state;
    const md = files(s).get('static/index.html.md')!;
    expect(md).toContain('\\## Details\n\n\\>quoted\n\n1\\. First\\\n2\\) Second\\\n\\---\n\n12 River Lane\\\nTownsville');
  });

  it('previews the summary as it is typed, for the same documents', () => {
    const { state } = seoSite();
    expect(generateLlmsTxt(state, { summary: 'Typed so far' })).toBe(llmsTxt(state)!.replace(`> ${state.site.description}`, '> Typed so far'));
    expect(generateLlmsTxt(state, { summary: '' })).toBe(llmsTxt(state));
  });

  it('keeps a collection’s entries under its own heading, whatever it is called', () => {
    const { state } = seoSite();
    const s = run(state, { type: 'collection.update', collectionId: 'posts', name: 'Pages' } as never);
    expect(s.collections.posts.settings.name).toBe('Pages');
    const text = llmsTxt(s)!;
    expect(text.match(/^## Pages$/gm)).toHaveLength(2);
    expect(text.split('## Pages')[2]).toContain('Spring pottery classes');
    expect(text.split('## Pages')[1]).not.toContain('Spring pottery classes');
  });
});

describe('Markdown copies', () => {
  const BODY: RichText = [
    { type: 'p', spans: [{ text: 'We throw, ' }, { text: 'trim', strong: true }, { text: ' and glaze. See ' }, { text: 'our services', link: { type: 'page', target: 'pg_services' } }, { text: '.' }] },
    { type: 'h3', spans: [{ text: 'What to bring' }] },
    { type: 'ul', items: [[{ text: 'An apron' }], [{ text: 'Old clothes' }]] }
  ];

  /**
   * Home with a text section and questions, and Foundation's table. `release` places Foundation's own text section and
   * FAQ; otherwise the project's designs stand in for them.
   */
  function richHome({ release = false } = {}) {
    const site = designedSite();
    let s = discovery(site.state);
    const home = site.home;
    const text = insert(s, home, release ? 'content.text' : site.d.text, { heading: 'How classes run', body: BODY });
    s = text.state;
    s = insert(s, home, release ? 'faq.list' : site.d.faq, { heading: 'Questions', ...(release ? { lead: '', eyebrow: '' } : {}), items: [{ id: 'q1', question: 'Do I need experience?', answer: 'No. Beginners are welcome.' }] }).state;
    s = insert(s, home, 'data.table', {
      heading: 'Timetable',
      caption: 'Weekly classes',
      table: { columns: [{ id: 'col_day', label: 'Day' }, { id: 'col_class', label: 'Class | level' }], rows: [{ id: 'row_mon', cells: { col_day: 'Monday', col_class: 'Wheel | beginners' } }, { id: 'row_any', cells: { col_class: 'Glazing' } }] }
    }).state;
    return { s, home, services: site.services, textNode: text.nodeId, d: site.d };
  }

  it('keeps a design’s headings, paragraphs, lists, links and questions with their answers, and the theme’s table, without the header and footer', () => {
    const { s } = richHome();
    const md = files(s).get('static/index.html.md')!;
    expect(md.startsWith('# Home\n\nURL: https://example.com/studio/\n\n> Pottery classes for beginners')).toBe(true);
    // The page's own headings sit under its title.
    expect(md).toContain('\n### How classes run\n');
    expect(md).toContain('We throw, **trim** and glaze. See [our services](https://example.com/studio/services/).');
    expect(md).toContain('#### What to bring\n\n- An apron\n- Old clothes');
    expect(md).toContain('**Do I need experience?**\n\nNo. Beginners are welcome.');
    expect(md).toContain('### Timetable\n\n**Weekly classes**\n\n| Day | Class \\| level |\n| --- | --- |\n| Monday | Wheel \\| beginners |\n|   | Glazing |');
    // The shared header's menu and the footer are not the page's content.
    const header = s.site.shell.header.rootIds.map((id) => s.site.shell.header.nodes[id] as InstanceNode)[0];
    expect(header).toBeTruthy();
    expect(md).not.toContain('Skip to');
    expect(md.match(/\[Services\]/g)).toBeNull();
    const footer = generateProject(s).get('src/lib/siteorigin/shell/Footer.svelte') ?? '';
    const footerWords = [...s.site.shell.footer.rootIds].flatMap((id) => Object.values((s.site.shell.footer.nodes[id] as InstanceNode).props ?? {})).filter((v): v is string => typeof v === 'string' && v.length > 6);
    expect(footer.length + footerWords.length).toBeGreaterThan(0);
    for (const words of footerWords) expect(md).not.toContain(words);
  });

  it('keeps the headings, paragraphs, lists, links, tables and questions with their answers of Foundation’s sections, without the header and footer', () => {
    // What a Foundation site's own sections say, as the app ships them.
    const { s } = richHome({ release: true });
    const md = files(s).get('static/index.html.md')!;
    expect(md.startsWith('# Home\n\nURL: https://example.com/studio/\n\n> Pottery classes for beginners')).toBe(true);
    // The page's own headings sit under its title.
    expect(md).toContain('\n### How classes run\n');
    expect(md).toContain('We throw, **trim** and glaze. See [our services](https://example.com/studio/services/).');
    expect(md).toContain('#### What to bring\n\n- An apron\n- Old clothes');
    expect(md).toContain('**Do I need experience?**\n\nNo. Beginners are welcome.');
    expect(md).toContain('### Timetable\n\n**Weekly classes**\n\n| Day | Class \\| level |\n| --- | --- |\n| Monday | Wheel \\| beginners |\n|   | Glazing |');
    // The shared header's menu and the footer are not the page's content.
    const header = s.site.shell.header.rootIds.map((id) => s.site.shell.header.nodes[id] as InstanceNode)[0];
    expect(header).toBeTruthy();
    expect(md).not.toContain('Skip to');
    expect(md.match(/\[Services\]/g)).toBeNull();
    const footer = generateProject(s).get('src/lib/siteorigin/shell/Footer.svelte') ?? '';
    const footerWords = [...s.site.shell.footer.rootIds].flatMap((id) => Object.values((s.site.shell.footer.nodes[id] as InstanceNode).props ?? {})).filter((v): v is string => typeof v === 'string' && v.length > 6);
    expect(footer.length + footerWords.length).toBeGreaterThan(0);
    for (const words of footerWords) expect(md).not.toContain(words);
  });

  it('keeps a quote apart from the words after it in a list item, and a working button’s words when its page is not listed', () => {
    const { state, home, services, d } = designedSite();
    let s = discovery(run(state, { type: 'page.update', pageId: services, noindex: true }));
    s = insert(s, home, d.testimonials, { heading: 'Kind words', items: [{ id: 't1', quote: 'The best class in town.', name: 'Ana Ruiz', role: 'Student' }] }).state;
    s = insert(s, home, d.cta, { heading: 'Ready?', primaryLabel: 'See our classes', primaryLink: { type: 'page', target: services } }).state;
    const md = files(s).get('static/index.html.md')!;
    const item = md.slice(md.indexOf('- '), md.indexOf('Ana Ruiz') + 'Ana Ruiz'.length);
    expect(item).toMatch(/^- (> )?.*The best class in town\./);
    if (item.includes('> ')) expect(item).toMatch(/town\.\n\n {2}/);
    expect(md).toContain('See our classes');
    expect(md).not.toContain('services');
  });

  it('is the same Markdown in the copy and in the full text once the site has a public URL', () => {
    const { s } = richHome();
    const out = files(s);
    const full = out.get('static/llms-full.txt')!;
    const copies = ['static/index.html.md', 'static/services/index.html.md', `static${postRoute(s)}index.html.md`].map((p) => out.get(p)!.trimEnd());
    // The site's opening, then each document once, in the index's order.
    expect(full).toBe(['# Riverside Studio\n\n> A pottery studio by the river, with classes for beginners and a shop of handmade work.', ...copies].join('\n\n---\n\n') + '\n');
  });

  it('writes an entry’s title, dates, excerpt and text, and a link to a draft entry as its words alone', () => {
    let s = discovery(seoSite().state);
    s = run(s, { type: 'entry.update', collectionId: 'posts', entryId: 'en_spring', updatedAt: '2027-03-09' } as never);
    expect(files(s).get(`static${postRoute(s)}index.html.md`)).toContain('Published: 2027-03-02 · Updated: 2027-03-09');
    s = run(
      s,
      { type: 'entry.create', collectionId: 'posts', entryId: 'en_later', title: `Later ${SECRET}`, draft: true },
      { type: 'entry.update', collectionId: 'posts', entryId: 'en_spring', updatedAt: '2027-03-02', body: [{ type: 'p', spans: [{ text: 'Read the ' }, { text: 'next post', link: { type: 'entry', target: 'en_later' } }, { text: '.' }] }] } as never
    );
    expect(files(s).get(`static${postRoute(s)}index.html.md`)).toContain('Read the next post.');
    s = discovery(seoSite().state);
    const md = files(s).get(`static${postRoute(s)}index.html.md`)!;
    expect(md).toBe(
      [
        '# Spring pottery classes',
        '',
        `URL: https://example.com/studio${postRoute(s)}`,
        '',
        '> Spring wheel classes open for bookings: six weeks of throwing, trimming and glazing.',
        '',
        'Published: 2027-03-02',
        '',
        'Our spring classes open for bookings this week.',
        '',
        '## What you will make',
        '',
        '### Bowls and cups',
        '',
        'Every student leaves with a set.',
        '',
        '## When',
        ''
      ].join('\n')
    );
  });

  it('keeps the words of a link to a noindex page but not where it goes, and leaves out its card', () => {
    const { s: rich, home, services, d } = richHome();
    let s = run(rich, { type: 'page.update', pageId: services, noindex: true, description: `Hidden ${SECRET}` });
    s = insert(s, home, d.pages, { heading: 'Explore', items: [{ id: 'it1', pageLink: { type: 'page', target: services }, title: '', description: '' }] }).state;
    const md = files(s).get('static/index.html.md')!;
    expect(md).toContain('We throw, **trim** and glaze. See our services.');
    expect(md).not.toContain('/services/');
    expect(md).not.toContain(SECRET);
    // Listed again, the card shows the page's own title and description, as a link.
    const listed = run(s, { type: 'page.update', pageId: services, noindex: false });
    expect(files(listed).get('static/index.html.md')).toContain(`### Explore\n\n- [Services](https://example.com/studio/services/)\n  Hidden ${SECRET}`);
  });

  it('lists the posts and articles of news lists that agents are told of, and leaves out the rest', () => {
    const { state, home, services, d } = designedSite();
    let s = discovery(run(state, { type: 'page.update', pageId: services, articleDate: '2027-01-05', excerpt: `Classes ${SECRET}` } as never));
    s = insert(s, home, d.posts, { heading: 'Latest posts' }).state;
    s = insert(s, home, d.news, { heading: 'Studio news' }).state;
    const md = files(s).get('static/index.html.md')!;
    expect(md).toContain(`[Spring pottery classes](https://example.com/studio${postRoute(s)})`);
    expect(md).toContain(`[Services](https://example.com/studio/services/)`);
    // Hidden from search engines, the article leaves the list: nothing of it is shown.
    const hidden = files(run(s, { type: 'page.update', pageId: services, noindex: true })).get('static/index.html.md')!;
    expect(hidden).toContain('### Studio news');
    expect(hidden).not.toContain(SECRET);
    expect(hidden).not.toContain('services');
    // The post keeps its own copy.
    expect(files(s).has(`static${postRoute(s)}index.html.md`)).toBe(true);
  });

  it('leaves out a component part hidden at every size, and an entry text its layout does not show', () => {
    const { s: rich, home } = richHome();
    const faq = Object.values(rich.pages[home].nodes).find((n) => n.kind === 'instance' && rich.components[n.definitionId].name === 'FAQ')!;
    const s = run(rich, { type: 'node.setStyle', owner: { kind: 'page', id: home }, nodeId: faq.id, partId: 'answer', scope: 'base', property: 'hidden', value: true });
    const md = files(s).get('static/index.html.md')!;
    expect(md).toContain('**Do I need experience?**');
    expect(md).not.toContain('Beginners are welcome');
    // A layout without the entry's text: its page shows none, nor does its copy.
    const layout = s.collections.posts.settings.template!;
    const bodyNode = Object.values(layout.nodes).find((n) => n.kind === 'text' && JSON.stringify(n.text).includes('"$entry":"body"'));
    expect(bodyNode).toBeTruthy();
    const noBody = run(s, { type: 'node.remove', owner: { kind: 'template', id: 'posts' }, nodeId: bodyNode!.id });
    const copy = files(noBody).get(`static${postRoute(noBody)}index.html.md`)!;
    expect(copy).toContain('# Spring pottery classes');
    expect(copy).not.toContain('Every student leaves with a set.');
  });

  it('is linked from the head of each page and entry that has one, and only while the site writes them', () => {
    const { state, services } = seoSite();
    const s = discovery(run(state, { type: 'page.update', pageId: services, noindex: true }));
    const out = files(s);
    const LINK = '<link rel="alternate" type="text/markdown" href="./index.html.md" />';
    // In the head, where agents look for it.
    for (const file of [pageFile(s.pages[s.site.homePageId]), entryFile(postRoute(s))]) {
      const source = out.get(file)!;
      expect(source.indexOf(LINK)).toBeGreaterThan(source.indexOf('<svelte:head>'));
      expect(source.indexOf(LINK)).toBeLessThan(source.indexOf('</svelte:head>'));
    }
    expect(out.get(pageFile(s.pages[services]))).not.toContain(LINK);
    const off = discovery(s, false);
    expect(files(off).get(pageFile(off.pages[off.site.homePageId]))).not.toContain(LINK);
  });

  it('gives a cached run the same files as a fresh one as the settings and pages change, and leaves the index alone for a body edit', () => {
    const cache = new GenerationCache();
    const { s: rich, home, services, textNode } = richHome();
    const steps: ProjectState[] = [rich, run(rich, { type: 'page.update', pageId: services, noindex: true }), discovery(rich, false), run(rich, { type: 'page.update', pageId: services, route: '/classes/' })];
    for (const s of steps) {
      const cached = generateProject(s, {}, cache);
      expect([...cached.entries()].sort()).toEqual([...generateProject(s).entries()].sort());
    }
    // Words on Home change Home's copy and the full text, and never the index of titles and descriptions.
    const last = steps[steps.length - 1];
    const before = generateProject(last, {}, cache);
    const edited = run(last, { type: 'instance.setProp', owner: { kind: 'page', id: home }, nodeId: textNode, prop: 'heading', value: 'Classes by the river' });
    const after = generateProject(edited, {}, cache);
    expect(after.get('static/index.html.md')).toContain('### Classes by the river');
    expect(after.get('static/llms-full.txt')).toContain('### Classes by the river');
    expect([...after.entries()].sort()).toEqual([...generateProject(edited).entries()].sort());
    expect(cache.made).toContain(`md:page\n${home}\n`);
    expect(cache.made).not.toContain('llms.txt');
    expect(after.get('static/llms.txt')).toBe(before.get('static/llms.txt'));
  });

  it('writes the document for a file anywhere, and nothing for a document agents are not told of', () => {
    const { state, services } = seoSite();
    expect(documentMarkdown(state, { kind: 'page', pageId: services }, '/')).toContain('# Services');
    expect(documentMarkdown(run(state, { type: 'page.update', pageId: services, noindex: true }), { kind: 'page', pageId: services }, '/')).toBe('');
  });
});

describe('settings, audit and reserved addresses', () => {
  it('stores each setting only while it differs from its default', () => {
    const { state } = seoSite();
    const on = run(state, { type: 'site.update', llmsTxt: false, llmsFull: true, markdownMirrors: true, llmsSummary: 'Pots.' });
    expect([on.site.llmsTxt, on.site.llmsFull, on.site.markdownMirrors, on.site.llmsSummary]).toEqual([false, true, true, 'Pots.']);
    const back = run(on, { type: 'site.update', llmsTxt: true, llmsFull: false, markdownMirrors: false, llmsSummary: ' ' });
    for (const k of ['llmsTxt', 'llmsFull', 'markdownMirrors', 'llmsSummary']) expect(Object.hasOwn(back.site, k)).toBe(false);
    // A value of another kind, written by hand, is no choice: the defaults stand.
    expect(agentDiscovery({ ...state.site, llmsTxt: 'no' as never, llmsFull: 1 as never, markdownMirrors: 'yes' as never, llmsSummary: 42 as never })).toEqual({ llmsTxt: true, llmsFull: false, markdownMirrors: false, summary: state.site.description });
  });

  it('tells the AI the settings once they differ from the defaults', () => {
    const { state } = seoSite();
    expect(projectSummary(state, 1).site).not.toHaveProperty('agentDiscovery');
    const changed = run(state, { type: 'site.update', markdownMirrors: true, llmsSummary: 'Pots.' });
    expect(projectSummary(changed, 1).site).toMatchObject({ agentDiscovery: { llmsTxt: true, llmsFull: false, markdownMirrors: true, summary: 'Pots.' } });
  });

  it('reports a site without llms.txt, and one whose llms.txt lists nothing', () => {
    const { state, home, services } = seoSite();
    const codes = (s: ProjectState) => runSeoAudit(s).filter((f) => f.code.startsWith('SEO_LLMS')).map((f) => [f.code, f.pillar, f.severity, f.site, f.destination ?? null]);
    expect(codes(state)).toEqual([]);
    expect(codes(run(state, { type: 'site.update', llmsTxt: false }))).toEqual([['SEO_LLMS_TXT_OFF', 'agentic', 'info', 'llmsTxt', { kind: 'site', field: 'llmsTxt' }]]);
    const hidden = run(state, { type: 'page.update', pageId: home, noindex: true }, { type: 'page.update', pageId: services, noindex: true }, { type: 'entry.update', collectionId: 'posts', entryId: 'en_spring', draft: true } as never);
    expect(codes(hidden)).toEqual([['SEO_LLMS_TXT_EMPTY', 'agentic', 'warning', 'llmsTxt', null]]);
  });

  it('keeps the discovery files’ addresses from pages, and their files out of saved versions', () => {
    for (const route of ['/llms.txt/', '/llms-full.txt/', '/about/index.html.md/']) expect(validateRoute(route)).not.toBeNull();
    expect(validateRoute('/llms/')).toBeNull();
    expect(heldAsMedia('static/llms.txt')).toBe(false);
    expect(heldAsMedia('static/llms-full.txt')).toBe(false);
    expect(heldAsMedia('static/guide/notes.md')).toBe(true);
  });
});

describe('a Markdown copy edited outside the app', () => {
  it('stays named in Project health once the website no longer has it, so no export carries its words, until it is restored away', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'so-llms-'));
    try {
      const { state, services } = seoSite();
      const s = await ProjectSession.create(dir, discovery(state));
      s.settleMs = 0;
      const rel = 'static/services/index.html.md';
      const edited = readFileSync(join(dir, rel), 'utf8') + `\n${SECRET}\n`;
      writeFileSync(join(dir, rel), edited);
      // Hidden from search engines, the page has no copy: the edited file stays, and is named, save after save.
      await s.apply({ operations: [{ type: 'page.update', pageId: services, noindex: true }] }, { label: 'Hide' });
      expect(readFileSync(join(dir, rel), 'utf8')).toBe(edited);
      expect(s.conflicts).toContainEqual(expect.objectContaining({ path: rel, kind: 'generated', builderMissing: true }));
      await s.apply({ operations: [{ type: 'page.update', pageId: services, title: 'Classes' }] }, { label: 'Rename' });
      expect(s.conflicts).toContainEqual(expect.objectContaining({ path: rel, kind: 'generated' }));
      // Restored, it goes, and what was written in it is kept as a copy.
      await s.restoreGeneratedFile(rel);
      expect(existsSync(join(dir, rel))).toBe(false);
      expect(s.conflicts.some((c) => c.path === rel)).toBe(false);
      const kept = s.savedCopies.find((c) => c.path === rel)!;
      expect(readFileSync(join(dir, kept.file), 'utf8')).toBe(edited);
      expect(readdirSync(join(dir, 'static/services')).filter((f) => f.includes('restoring'))).toEqual([]);
      await s.apply({ operations: [{ type: 'page.update', pageId: services, title: 'Services' }] }, { label: 'Rename' });
      expect(s.conflicts).toEqual([]);
      // A copy nobody edited is simply removed when the page leaves the index, and a folder put where one was is not a copy.
      const home = 'static/index.html.md';
      const post = `static${postRoute(s.state)}index.html.md`;
      rmSync(join(dir, post));
      mkdirSync(join(dir, post));
      writeFileSync(join(dir, post, 'notes.txt'), 'Notes');
      await s.apply({ operations: [{ type: 'site.update', markdownMirrors: false }] }, { label: 'Off' });
      expect(existsSync(join(dir, home))).toBe(false);
      expect(existsSync(join(dir, post, 'notes.txt'))).toBe(true);
      expect(s.conflicts).toEqual([]);
      await s.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('leaves the save unfinished when files for a state taken from disk cannot be written, so no export runs on old ones', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'so-llms-'));
    try {
      const s = await ProjectSession.create(dir, discovery(seoSite().state));
      const inner = s as unknown as { publishGenerated: () => Promise<string[]>; publishInstalled: () => Promise<string[]> };
      const spy = vi.spyOn(inner, 'publishGenerated').mockRejectedValueOnce(new Error('The disk is full.'));
      await expect(inner.publishInstalled()).rejects.toThrow('The disk is full.');
      expect(s.saveUnfinished).toBe(true);
      spy.mockRestore();
      await s.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
