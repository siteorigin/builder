/**
 * What a person can do in Builder, one row per user intent (issue #498): where they start, the discoverable actions that
 * get them there, what proves it happened, the scenario it is proven in, where it applies, the tests that prove it, and
 * what is still missing, with its owner.
 *
 * `tests/unit/interaction-coverage.test.ts` holds this list to the app: every action the readers in surfaces.ts find
 * (the application and writing menus, the command menu, the sidebar's views, the editor's shortcuts, every menu the
 * editor draws) is a route of some row, every route of those kinds still exists, every e2e script is linked from a row,
 * and every linked test and named step is there. A change that adds an interaction adds or extends its row here, with a
 * proof or an owned gap (CONTRIBUTING.md, "Interaction coverage").
 *
 * `node tests/coverage/interactions.ts --markdown` prints the list as tables, one per area.
 */
import { pathToFileURL } from 'node:url';
import type { Platform } from './surfaces.ts';

export type Area =
  | 'projects'
  | 'pages'
  | 'layers'
  | 'inspector'
  | 'styles'
  | 'insert'
  | 'components'
  | 'code'
  | 'assets'
  | 'find'
  | 'history'
  | 'preview'
  | 'export'
  | 'assistant'
  | 'posts'
  | 'settings'
  | 'desktop';

/** The areas, in the order the tables are printed. */
export const AREAS: Record<Area, string> = {
  projects: 'Projects: create, open, duplicate, trust, recover, close',
  pages: 'Pages, navigation and SEO',
  layers: 'Layers, selection, multi-select, clipboard and drag',
  inspector: 'Inspector content, breakpoints and states',
  styles: 'Site styles, tokens, fonts and themes',
  insert: 'Insert and canvas building',
  components: 'Component authoring and Component Studio',
  code: 'Code mode and diagnostics',
  assets: 'Assets, fonts and import',
  find: 'Search and replace',
  history: 'History, versions, conflicts and read-only',
  preview: 'Editor and visitor preview',
  export: 'Export, errors and reopening',
  assistant: 'AI conversations, attachments, edits and approvals',
  posts: 'Collections and posts',
  settings: 'Settings and editor layout',
  desktop: 'Desktop menus, choosers and text editing'
};

/**
 * How a test proves a row: `driver` drives the public test driver (tests/driver) as a client would; `e2e` drives the
 * built app with Playwright directly (tests/e2e/harness.mjs); `unit` tests a lower layer; `packaged` runs the packaged
 * app (`npm run pack`); `design` only captures screens.
 */
export type ProofKind = 'driver' | 'e2e' | 'unit' | 'packaged' | 'design';

export interface Proof {
  /** The test file, from the repository root. */
  test: string;
  kind: ProofKind;
  /** A `step('…')` (or `it('…')`) text the test has, naming where it proves this row. */
  step?: string;
}

/** What is not proven yet, and who owns it: an open issue when there is one, else the area that should take it. */
export interface Gap {
  missing: string;
  owner: string;
  issue?: number;
}

export interface Interaction {
  /** Stable, `area.what`. */
  id: string;
  area: Area;
  /** What the person wants to do, in their words. */
  intent: string;
  /** The state it starts from. */
  start: string;
  /**
   * The discoverable actions that do it. Keys from surfaces.ts (`menu:`, `role:`, `writing:`, `command:`, `tab:`,
   * `key:`, `item:`) are checked against the app; the rest name a control where a person finds it: `welcome:`,
   * `toolbar:`, `panel:`, `inspector:`, `canvas:`, `preview:`, `chat:`, `dialog:`, `status:`.
   */
  routes: string[];
  /** What a test checks to say it happened: on screen, in the saved project, in an export. */
  outcome: string;
  /** The fixture and provider it is proven with (`welcome · scripted`, `business-v1 · none`, ...). */
  scenario: string;
  /** The platforms it applies to (default: all three). */
  platforms?: Platform[];
  /** The builds a test proves it on (default: the unpacked build the e2e scripts launch). */
  builds?: ('dev' | 'packaged')[];
  proof: Proof[];
  gaps?: Gap[];
}

/** Open issues that own gaps, by number: the work that will close them. */
export const GAP_ISSUES: Record<number, string> = {
  130: 'Run the live provider checks',
  346: 'Build rich visual components, local-model tools and site collections',
  489: 'Let external AI testers drive and verify the whole Builder app',
  672: 'Build optional flat-file CMS, collection loops, and read-only external API sources',
  699: 'Move SEO previews into a dedicated SEO view'
};

const J = 'tests/e2e/journeys.mjs';

export const INTERACTIONS: Interaction[] = [
  {
    id: 'journey.principal',
    area: 'projects',
    intent: 'Start from nothing, make a site, change it, talk it through with the assistant, export it and come back to it',
    start: 'Welcome in a fresh profile, scripted assistant',
    routes: ['welcome:New project', 'dialog:New project › Create project', 'tab:layers', 'inspector:Heading', 'chat:Message', 'toolbar:Undo', 'toolbar:Redo', 'menu:File > Export…', 'menu:File > Close Project', 'menu:File > Open Project…'],
    outcome: 'The edit and the approved AI change are in the home page document and the preview; Undo and Redo move only the AI change; the exported index.html holds both; the reopened project still does; the whole run replays from its record in a fresh session',
    scenario: 'welcome · scripted',
    proof: [
      { test: J, kind: 'driver', step: 'principal journey' },
      { test: J, kind: 'driver', step: 'the recorded journey replays in a fresh session' },
      { test: 'scripts/model-smoke.mjs', kind: 'driver' }
    ]
  },
  {
    id: 'journey.cancelled',
    area: 'projects',
    intent: 'Change my mind: cancel opening a project, and say no to the assistant changing more than I asked',
    start: 'Welcome, then a project with the hero selected',
    routes: ['welcome:Open project', 'menu:File > Open Project…', 'chat:No, only change the selection'],
    outcome: 'A cancelled chooser leaves Welcome as it was with no project opened; a declined wider change leaves the site name as it was',
    scenario: 'welcome · scripted',
    proof: [{ test: J, kind: 'driver', step: 'cancelled journey' }]
  }
];

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');

/** The list as Markdown: one table per area, then the gaps. */
export function toMarkdown(rows: Interaction[] = INTERACTIONS): string {
  const out = ['# Interaction coverage', '', `${rows.length} user intents. Generated from tests/coverage/interactions.ts.`, ''];
  for (const [area, title] of Object.entries(AREAS) as [Area, string][]) {
    const inArea = rows.filter((r) => r.area === area);
    if (!inArea.length) continue;
    out.push(`## ${title}`, '', '| Intent | Start | Routes | Outcome | Scenario | Applies | Proof | Gaps |', '| --- | --- | --- | --- | --- | --- | --- | --- |');
    for (const r of inArea) {
      const applies = `${(r.platforms ?? ['darwin', 'win32', 'linux']).join(', ')}; ${(r.builds ?? ['dev']).join(', ')}`;
      const proof = r.proof.map((p) => `${p.test.replace(/^tests\//, '')} (${p.kind})`).join('<br>');
      const gaps = (r.gaps ?? []).map((g) => `${g.missing} (${g.issue ? `#${g.issue}` : g.owner})`).join('<br>');
      out.push(`| ${[r.intent, r.start, r.routes.map((x) => `\`${x}\``).join(' '), r.outcome, r.scenario, applies, proof, gaps].map(cell).join(' | ')} |`);
    }
    out.push('');
  }
  return out.join('\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href && process.argv.includes('--markdown')) process.stdout.write(`${toMarkdown()}\n`);
