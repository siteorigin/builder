/**
 * One result envelope from every AI tool (#744): every result the model receives, success or failure, has `ok` and the
 * `revision` it reflects, and every failure an `error` object with a code from one set, a message and `recoverable`.
 * Each tool is called once to succeed and once to fail, directly and through a run, and the orchestrator's own
 * refusals (a second change in one step, a tool not offered, a write in a question, a stopped run) are held to it too.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AiEvent, ChatContext } from '@shared/api';
import type { AssetRecord, ElementRef, InstanceNode, ListItem, ProjectState } from '@shared/types';
import { TOOL_ERROR_CODES, type EditOperation } from '@shared/ops';
import type { ComponentPreviewResult, ComponentPreviewStep } from '@shared/component-preview';
import type { PreviewControlResult } from '@shared/preview-control';
import { createStarterState } from '@catalogue/starters';
import { catalogueComponent } from '@catalogue/index';
import { P, prop } from '@catalogue/dsl';
import { projectDesign } from './fixtures/packs';
import { definitionHash } from '@shared/migrations';
import { applyOperations, sourceHash } from '@engine/apply';
import { installComponent, makeInstance } from '@engine/install';
import { Orchestrator } from '@agent/orchestrator';
import type { AgentModelAdapter, CanonicalItem, CanonicalModelRequest, ModelCapabilities, ModelEvent } from '@agent/types';
import { executeTool, MUTATING_TOOLS, serializeResult, TOOL_ARGS, type ToolHost, type ToolName } from '@agent/tools';
import { newMacroMemory } from '@agent/macros';
import { applyFailure, MAX_RESULT_CHARS, stamp, toolError, type ToolResult } from '@agent/result';
import { applyContextBudget } from '@agent/budget';
import { ProjectSession } from '../../src/main/project/session';
import type { SourceToolHost } from '@agent/source-tools';
import { sourceConversionKey, sourceFingerprint } from '@shared/sources';

/**
 * Tools a test adds to those a run is offered, so a guard behind them (a write in a question) can be reached, and every
 * outcome a run's calls came to, for one the model never sees (a stopped run sends no further request).
 */
const hooks = vi.hoisted(() => ({ offer: [] as string[], outcomes: [] as Array<{ name: string; content: unknown }> }));
vi.mock('@agent/tools', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@agent/tools')>();
  return {
    ...mod,
    toolsForRun: (opts: Parameters<typeof mod.toolsForRun>[0]) => {
      const r = mod.toolsForRun(opts);
      const extra = mod.toolDefinitions({ codeEnabled: true, definitionOps: true }).filter((t) => hooks.offer.includes(t.name) && !r.tools.some((x) => x.name === t.name));
      return { ...r, tools: [...r.tools, ...extra] };
    },
    executeTool: async (...args: Parameters<typeof mod.executeTool>) => {
      const out = await mod.executeTool(...args);
      hooks.outcomes.push({ name: args[0], content: out.content });
      return out;
    }
  };
});

const dirs: string[] = [];
afterEach(() => {
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
  hooks.offer = [];
  hooks.outcomes = [];
});

const HEADER = catalogueComponent('foundation', 'shell.header')!.id;
const PHOTO: AssetRecord = { id: 'a_kiln', name: 'Kiln', file: 'static/assets/kiln-1a2b3c4d.jpg', mime: 'image/jpeg', bytes: 10, width: 1200, height: 800, hash: 'h', kind: 'image', createdAt: '2026-01-01T00:00:00.000Z' };

/**
 * The business starter with something for every tool: a library image, a code component, a blog, a table on Home, a
 * header older than the theme's (so it has an update to take) and a managed Split hero of the project's own, to be
 * edited everywhere (Foundation's hero is a code component, which the design tools do not edit).
 */
function project(): { state: ProjectState; note: string; design: string } {
  let s = structuredClone(createStarterState('business', 'Envelope', false));
  s.assets.assets[PHOTO.id] = PHOTO;
  const header = s.components[HEADER];
  delete (header.properties as Record<string, unknown>).ctaStyle;
  delete (s.site.shell.header.nodes[s.site.shell.header.rootIds[0]] as InstanceNode).props.ctaStyle;
  s.themeLock.components[HEADER].hash = definitionHash(header);
  const home = s.pages[s.site.homePageId];
  const table = makeInstance(s.components[installComponent(s, 'data.table')]);
  home.nodes[table.id] = table;
  home.rootIds.push(table.id);
  const design = projectDesign(s, {
    componentId: 'project.split-hero',
    name: 'Split hero',
    properties: {
      heading: P.str('Heading', 'Thoughtful work'),
      lead: P.text('Supporting text', 'We help small teams.'),
      primaryLabel: P.str('Primary button label', 'Start a project'),
      primaryLink: P.link('Primary button link'),
      secondaryLabel: P.str('Secondary button label', 'See our work'),
      secondaryLink: P.link('Secondary button link')
    },
    parts: { root: { nodeId: 'root', label: 'Section', styleControls: ['paddingBlock', 'background'] }, heading: { nodeId: 'heading', label: 'Heading' }, lead: { nodeId: 'lead', label: 'Supporting text' } },
    variantAxes: { tone: { label: 'Tone', default: 'default', options: { default: { label: 'Default' }, muted: { label: 'Soft background', styles: { root: { base: { background: { token: 'color.surface-alt' } } } } } } } },
    build: (b) =>
      b.el('root', 'section', { name: 'Section' }, [
        b.el('content', 'div', { name: 'Content' }, [
          b.text('heading', 'h1', prop('heading'), { name: 'Heading', when: prop('heading') }),
          b.text('lead', 'p', prop('lead'), { name: 'Supporting text', when: prop('lead') }),
          b.el('actions', 'div', { name: 'Actions', collapseEmpty: true }, [
            b.link('primary', prop('primaryLink'), prop('primaryLabel'), 'primary', { name: 'Primary button', when: prop('primaryLabel') }),
            b.link('secondary', prop('secondaryLink'), prop('secondaryLabel'), 'secondary', { name: 'Secondary button', when: prop('secondaryLabel') })
          ])
        ])
      ])
  }).id;
  const made = applyOperations(s, [
    { type: 'component.createCode', name: 'Note', source: '<p>x</p>\n', properties: {} },
    { type: 'collection.create', collectionId: 'posts' },
    { type: 'entry.create', collectionId: 'posts', entryId: 'en_spring', title: 'Spring open studio', publishedAt: '2027-03-02', draft: false, body: ['Twenty makers open their doors.'] },
    { type: 'collection.create', collectionId: 'staff', name: 'Staff', kind: 'structured', fields: { role: { type: 'string', label: 'Role' } } },
    { type: 'source.upsert', sourceId: 'team-api', name: 'Team API', adapter: 'rest', collectionId: 'staff', config: { url: 'https://api.example.test/team' } }
  ] as EditOperation[]);
  s = made.state;
  const note = (made.results[0] as { definitionId: string }).definitionId;
  return { state: s, note, design };
}

/** Where a tool is offered: the whole site, a question, a selection on Home, a component's design edited everywhere, or the blog's entry layout. */
type Where = 'site' | 'ask' | 'hero' | 'grid' | 'table' | 'design' | 'layout';

interface Case {
  where: Where;
  ok: (s: ProjectState, revision: number, ids: { note: string; design: string }) => unknown;
  fail: (s: ProjectState, revision: number, ids: { note: string; design: string }) => unknown;
  /** The code a call fails with. */
  code: (typeof TOOL_ERROR_CODES)[number];
  /**
   * In a run, the failing call goes in the same step as the one that works, with these arguments when they differ: a
   * tool the success takes out of the next step's offer (the only update done, the scope widened) is still offered.
   */
  sameStep?: { fail?: (s: ProjectState, revision: number, ids: { note: string; design: string }) => unknown };
  /** What the project needs first, done as the author would: a change in History for an Undo to take. */
  seed?: (session: ProjectSession) => Promise<unknown>;
}

/** The author's own change, for step_history to undo. */
const authorEdit = (session: ProjectSession) => session.apply({ operations: [{ type: 'page.update', pageId: session.state.site.homePageId, title: 'Welcome' }] }, { label: 'Rename Home', source: 'user' });

/** The editor's answer to set_preview, as its toolbar would give it at phone width. */
const previewAnswer = async (): Promise<PreviewControlResult> => ({ now: { width: 390, preset: 'phone', scheme: 'system', mode: 'edit', darkPalette: false }, changed: ['viewport'], refused: [] });

const home = (s: ProjectState) => s.pages[s.site.homePageId];
const rootAt = (s: ProjectState, i: number) => home(s).rootIds.at(i)!;
const onHome = (s: ProjectState) => ({ kind: 'page' as const, id: s.site.homePageId });
const firstItem = (s: ProjectState) => ((home(s).nodes[rootAt(s, 2)] as InstanceNode).props.items as ListItem[])[0].id;

const CASES = {
  read_project: { where: 'site', ok: () => ({}), fail: () => ({ sections: ['nope'] }), code: 'INVALID_ARGUMENT' },
  read_page: { where: 'site', ok: (s) => ({ pageId: s.site.homePageId }), fail: () => ({ pageId: 'pg_missing' }), code: 'INVALID_ARGUMENT' },
  inspect_element: { where: 'site', ok: (s) => ({ owner: onHome(s), nodeId: rootAt(s, 0) }), fail: (s) => ({ owner: onHome(s), nodeId: 'n_missing' }), code: 'INVALID_ARGUMENT' },
  search_components: { where: 'site', ok: () => ({ query: 'pricing' }), fail: () => ({ query: 'pricing', limit: 99 }), code: 'INVALID_ARGUMENT' },
  read_component: { where: 'site', ok: () => ({ componentId: 'features.grid' }), fail: () => ({ componentId: 'nothing.here' }), code: 'INVALID_ARGUMENT' },
  search_assets: { where: 'site', ok: () => ({ query: 'kiln' }), fail: () => ({ limit: 0 }), code: 'INVALID_ARGUMENT' },
  apply_operations: {
    where: 'site',
    ok: (s, revision) => ({ expectedRevision: revision, operations: [{ type: 'page.update', pageId: s.site.homePageId, title: 'Start here' }] }),
    fail: (s, revision) => ({ expectedRevision: revision + 5, operations: [{ type: 'page.update', pageId: s.site.homePageId, title: 'Too late' }] }),
    code: 'STALE_REVISION'
  },
  read_source: { where: 'site', ok: (_s, _r, ids) => ({ definitionId: ids.note }), fail: () => ({ definitionId: 'def_missing' }), code: 'INVALID_ARGUMENT' },
  apply_source_patch: {
    where: 'site',
    ok: (s, revision, ids) => ({ definitionId: ids.note, scope: { kind: 'site' }, expectedRevision: revision, expectedHash: sourceHash(s.components[ids.note].source ?? ''), edits: [{ find: '<p>', replace: '<p class="note">' }] }),
    fail: (_s, revision, ids) => ({ definitionId: ids.note, scope: { kind: 'site' }, expectedRevision: revision, expectedHash: 'sha_stale', edits: [{ find: '<p', replace: '<div' }] }),
    code: 'STALE_REVISION'
  },
  inspect_layout: { where: 'site', ok: (s) => ({ pageId: s.site.homePageId, viewport: 'phone' }), fail: () => ({ pageId: 'pg_missing', viewport: 'phone' }), code: 'INVALID_ARGUMENT' },
  inspect_component: { where: 'site', ok: () => ({ componentId: 'features.grid' }), fail: () => ({ componentId: 'features.grid', offset: 999 }), code: 'INVALID_ARGUMENT' },
  validate_project: { where: 'site', ok: () => ({}), fail: () => ({ profile: 'everything' }), code: 'INVALID_ARGUMENT' },
  audit_seo: { where: 'site', ok: () => ({}), fail: () => ({ pageId: 'pg_missing' }), code: 'INVALID_ARGUMENT' },
  request_clarification: { where: 'site', ok: () => ({ question: 'Which one?', choices: ['This', 'That'] }), fail: () => ({ question: 'Which picture, and may I change more?', widenScope: true, assetIds: [PHOTO.id] }), code: 'INVALID_ARGUMENT' },
  locate_field: { where: 'ask', ok: (s) => ({ owner: onHome(s), nodeId: rootAt(s, 0), prop: 'heading' }), fail: (s) => ({ owner: onHome(s), nodeId: rootAt(s, 0), prop: 'nothing' }), code: 'INVALID_ARGUMENT' },
  upsert_page_with_sections: {
    where: 'site',
    ok: () => ({ slug: 'services', title: 'Services', sections: [{ componentId: 'intro.page', props: { heading: 'What we do', lead: 'Three clear services.' } }] }),
    fail: () => ({ slug: 'workshops', title: 'Workshops', sections: [{ componentId: 'features.grid', props: { heading: 'Workshops', items: [{ icon: 'not-an-icon', title: 'Raku' }] } }] }),
    code: 'VALIDATION_FAILED'
  },
  update_site_brand: { where: 'site', ok: () => ({ siteName: 'Riverside Studio' }), fail: () => ({ headingFont: 'Comic Sans' }), code: 'VALIDATION_FAILED' },
  update_page_seo: { where: 'site', ok: (s) => ({ pageId: s.site.homePageId, description: 'Handmade pots from the river.' }), fail: (s) => ({ pageId: s.site.homePageId, socialImage: 'a_missing0' }), code: 'VALIDATION_FAILED' },
  update_site_seo: { where: 'site', ok: () => ({ language: 'en-NZ' }), fail: () => ({ socialImage: 'a_missing0' }), code: 'VALIDATION_FAILED' },
  upsert_managed_component: {
    where: 'site',
    ok: () => ({ name: 'Card', nodes: [{ kind: 'element', id: 'root', tag: 'div' }] }),
    fail: () => ({ name: 'Banner', nodes: [{ kind: 'element', id: 'root', children: ['gone'] }] }),
    code: 'VALIDATION_FAILED'
  },
  list_collection_entries: { where: 'site', ok: () => ({ collectionId: 'posts' }), fail: () => ({ collectionId: 'nothing' }), code: 'VALIDATION_FAILED' },
  read_collection_entry: { where: 'site', ok: () => ({ collectionId: 'posts', entryId: 'en_spring' }), fail: () => ({ collectionId: 'posts', entryId: 'en_gone' }), code: 'VALIDATION_FAILED' },
  upsert_collection_entry: { where: 'site', ok: () => ({ collectionId: 'posts', entryId: 'en_spring', excerpt: 'Twenty makers open their doors.' }), fail: () => ({ collectionId: 'posts', entryId: 'en_spring', publishedAt: 'April 1st' }), code: 'VALIDATION_FAILED' },
  define_collection: {
    where: 'site',
    ok: () => ({ action: 'create', collectionId: 'team', name: 'Team', kind: 'structured', fields: [{ name: 'role', type: 'string', label: 'Role' }] }),
    fail: () => ({ action: 'update', collectionId: 'posts', fields: [{ name: 'level', type: 'enum' }] }),
    code: 'VALIDATION_FAILED'
  },
  connect_collection_list: {
    where: 'site',
    ok: (s) => ({ owner: onHome(s), nodeId: rootAt(s, 2), prop: 'items', query: { collectionId: 'posts', limit: 3 }, fields: [{ itemField: 'title', entryField: 'title' }, { itemField: 'description', entryField: 'excerpt' }] }),
    fail: (s) => ({ owner: onHome(s), nodeId: 'n_missing', prop: 'items', query: { collectionId: 'posts' } }),
    code: 'VALIDATION_FAILED'
  },
  inspect_source_sample: { where: 'site', ok: () => ({ sourceId: 'team-api' }), fail: () => ({ sourceId: 'nothing' }), code: 'INVALID_ARGUMENT' },
  write_source_converter: {
    where: 'site',
    ok: () => ({ sourceId: 'team-api', mapping: { externalId: 'uuid', title: 'headline', values: [{ field: 'role', path: 'job' }] } }),
    fail: () => ({ sourceId: 'team-api', mapping: { title: 'headline' }, converter: 'export function convert(items) { return items; }' }),
    code: 'INVALID_ARGUMENT'
  },
  read_layout: { where: 'layout', ok: () => ({}), fail: () => ({ nodeId: 'n_missing' }), code: 'INVALID_ARGUMENT' },
  edit_collection_layout: {
    where: 'site',
    ok: (_s, revision) => ({ owner: { kind: 'template', id: 'posts' }, expectedRevision: revision, action: 'edit', operations: [{ type: 'node.insert', primitive: 'paragraph', text: 'Written by the studio' }] }),
    fail: (_s, revision) => ({ owner: { kind: 'template', id: 'posts' }, expectedRevision: revision + 5, action: 'edit', operations: [{ type: 'node.insert', primitive: 'paragraph', text: 'Too late' }] }),
    code: 'STALE_REVISION'
  },
  update_theme_component: { where: 'site', ok: () => ({ definitionId: HEADER }), fail: () => ({ definitionId: 'proj.nothing-abcde' }), code: 'INVALID_ARGUMENT', sameStep: { fail: () => ({ definitionId: HEADER }) } },
  update_selected_props: { where: 'hero', ok: () => ({ props: { heading: 'Thoughtful spaces' } }), fail: () => ({ props: { nothing: 'here' } }), code: 'VALIDATION_FAILED' },
  edit_selected_list: { where: 'grid', ok: (s) => ({ prop: 'items', action: 'update', itemId: firstItem(s), fields: { title: 'Renamed' } }), fail: () => ({ prop: 'items', action: 'update', itemId: 'item_gone', fields: { title: 'Nowhere' } }), code: 'VALIDATION_FAILED' },
  edit_selected_table: { where: 'table', ok: () => ({ prop: 'table', action: 'setCell', rowId: 'row_2', columnId: 'col_time', value: '19:00' }), fail: () => ({ prop: 'table', action: 'removeRow', rowId: 'row_gone' }), code: 'INVALID_ARGUMENT' },
  style_selected_element: { where: 'hero', ok: () => ({ partId: 'root', scope: 'phone', styles: [{ property: 'paddingBlock', value: { token: 'space.lg' } }] }), fail: () => ({ partId: 'root', scope: 'base', styles: [{ property: 'nothing', value: 1 }] }), code: 'VALIDATION_FAILED' },
  request_wider_scope: { where: 'hero', ok: () => ({ question: 'May I change the rest of the page too?' }), fail: () => ({ question: '' }), code: 'INVALID_ARGUMENT', sameStep: {} },
  edit_definition_node: { where: 'design', ok: () => ({ nodeId: 'lead', content: { tag: 'h3' } }), fail: () => ({ nodeId: 'node_gone', content: { tag: 'h3' } }), code: 'VALIDATION_FAILED' },
  bind_definition_field: { where: 'design', ok: () => ({ nodeId: 'actions', field: 'when', binding: null }), fail: () => ({ nodeId: 'heading', field: 'text', binding: { $prop: 'nothing' } }), code: 'INVALID_ARGUMENT' },
  manage_component_prop: { where: 'design', ok: () => ({ change: { action: 'add', prop: 'badge', label: 'Badge', type: 'string', default: 'New' } }), fail: () => ({ change: { action: 'remove', prop: 'nothing' } }), code: 'VALIDATION_FAILED' },
  manage_component_state: { where: 'design', ok: () => ({ change: { action: 'add', state: 'plan', label: 'Plan', type: 'enum', options: ['monthly', 'annual'] } }), fail: () => ({ change: { action: 'remove', state: 'nothing' } }), code: 'VALIDATION_FAILED' },
  style_definition_element: { where: 'design', ok: () => ({ partId: 'root', scope: 'phone', styles: [{ property: 'paddingBlock', value: { token: 'space.lg' } }] }), fail: () => ({ partId: 'nothing', scope: 'base', styles: [{ property: 'gap', value: { token: 'space.lg' } }] }), code: 'VALIDATION_FAILED' },
  add_definition_variant: { where: 'design', ok: () => ({ axis: 'tone', option: 'bold', label: 'Bold' }), fail: () => ({ axis: 'tone', option: 'muted', label: 'Muted again' }), code: 'VALIDATION_FAILED' },
  insert_definition_node: { where: 'design', ok: () => ({ parentId: 'content', primitive: 'paragraph', text: 'Made by hand' }), fail: () => ({ parentId: 'heading', primitive: 'icon' }), code: 'VALIDATION_FAILED' },
  remove_definition_node: { where: 'design', ok: () => ({ nodeId: 'secondary' }), fail: () => ({ nodeId: 'node_gone' }), code: 'VALIDATION_FAILED' },
  set_preview: { where: 'ask', ok: () => ({ viewport: 'phone' }), fail: () => ({}), code: 'INVALID_ARGUMENT' },
  step_history: { where: 'site', seed: authorEdit, ok: () => ({ direction: 'undo' }), fail: () => ({ direction: 'sideways' }), code: 'INVALID_ARGUMENT' }
} satisfies Record<ToolName, Case>;

/** A measured case, as the component preview reports one with nothing wrong. */
const measured = (step: ComponentPreviewStep): ComponentPreviewResult => ({ state: 'ready', width: step.width, definitionId: 'x', bounds: null, text: '', report: { viewportWidth: step.width, issues: [], runtimeErrors: [], checks: { contrast: { checked: 3, failed: 0, unverified: 0 } }, gaps: [] } } as ComponentPreviewResult);

/** The selection each place stands for, as the editor sends it. */
function selectionAt(s: ProjectState, where: Where): ElementRef | null {
  const at = where === 'hero' ? 0 : where === 'grid' ? 2 : where === 'table' ? -1 : null;
  return at === null ? null : { owner: onHome(s), instancePath: [], nodeId: rootAt(s, at) };
}

async function sessionFor() {
  const dir = mkdtempSync(join(tmpdir(), 'so-envelope-'));
  dirs.push(dir);
  const { state, note, design } = project();
  return { session: await ProjectSession.create(dir, state), ids: { note, design } };
}

/** The main process's side of the source tools, as a source that has one record answers them. */
const sourcesOf = (session: ProjectSession): SourceToolHost => ({
  inspect: async () => ({ ok: true, raw: [{ uuid: 'u1', headline: 'Ana Ruiz', job: 'Potter' }], total: 1 }),
  verify: async (sourceId, change) => {
    const saved = session.state.sources![sourceId];
    const operation = { type: 'source.upsert', sourceId, name: saved.name, adapter: saved.adapter, collectionId: saved.collectionId, config: saved.config, ...change } as EditOperation;
    return { ok: true, operation, grant: { sourceId, base: sourceFingerprint(saved), change: sourceConversionKey(change) }, ticket: 't1', records: [], total: 1, created: 1, updated: 0, unchanged: 0, unpublished: 0, removed: 0, kept: 0 };
  },
  approve: async () => true
});

/** A host like the orchestrator's for a direct call: the session applies, with the call's grant. */
function hostFor(session: ProjectSession, where: Where, design: string): ToolHost {
  const sel = selectionAt(session.state, where);
  return {
    state: () => session.state,
    revision: () => session.revision,
    diagnostics: () => session.diagnostics(),
    apply: (operations, expectedRevision, label, key, grants) => session.apply({ operations, expectedRevision }, { label, source: 'ai', idempotencyKey: key, ...(grants?.collectionWrite ? { collectionWrite: grants.collectionWrite } : {}), ...(grants?.sourceWrite ? { sourceWrite: grants.sourceWrite } : {}) }),
    sources: sourcesOf(session),
    compileAll: async () => [],
    inspectLayout: async () => ({ issues: [], images: { total: 0, loaded: 0, failed: 0, unverified: 0 } }),
    inspectComponent: async (steps) => steps.map(measured),
    ask: async (_q, choices) => choices[0] ?? 'Yes',
    controlPreview: previewAnswer,
    // As a run that has changed nothing steps History (the orchestrator's host holds the run it began).
    stepHistory: async (direction, steps) => {
      if (session.activeRun?.id !== 'run_envelope') await session.beginRun('run_envelope');
      return session.stepHistoryForRun('run_envelope', direction, steps);
    },
    macros: newMacroMemory(),
    selection: () => (sel ? { owner: sel.owner, nodeId: sel.nodeId } : null),
    definitionTarget: () => (where === 'design' ? { definitionId: design } : null),
    selectionLimited: () => !!sel,
    pageLimit: () => null,
    entryLimit: () => null,
    layoutLimit: () => (where === 'layout' ? { owner: { kind: 'template', id: 'posts' }, label: 'the Posts layout' } : null),
    siteWide: () => where === 'site'
  };
}

/** The envelope every result has, whichever tool or refusal made it. */
function expectEnvelope(result: unknown, ok: boolean, where: string) {
  const r = result as Record<string, unknown>;
  expect(r.ok, where).toBe(ok);
  expect(Number.isInteger(r.revision), `${where}: revision ${JSON.stringify(r.revision)}`).toBe(true);
  if (ok) {
    expect(r.error, where).toBeUndefined();
    return;
  }
  expect(Object.keys(r).sort(), where).toEqual(['error', 'ok', 'revision']);
  const e = r.error as Record<string, unknown>;
  expect(typeof e, where).toBe('object');
  expect(TOOL_ERROR_CODES, `${where}: code ${String(e.code)}`).toContain(e.code);
  expect(typeof e.message === 'string' && e.message.length > 0, where).toBe(true);
  expect(typeof e.recoverable, where).toBe('boolean');
  expect(Object.keys(e).every((k) => ['code', 'message', 'recoverable', 'details'].includes(k)), where).toBe(true);
}

describe('one result envelope for every tool (#744)', () => {
  it('names every tool the model can be offered', () => {
    expect(Object.keys(CASES).sort()).toEqual(Object.keys(TOOL_ARGS).sort());
  });

  it.each(Object.keys(CASES) as ToolName[])('%s: a direct call succeeds and fails in the envelope', async (name) => {
    const c: Case = CASES[name];
    const { session, ids } = await sessionFor();
    await c.seed?.(session);
    const host = hostFor(session, c.where, ids.design);
    const before = session.revision;
    const ok = await executeTool(name, JSON.stringify(c.ok(session.state, session.revision, ids)), host, 'call_ok');
    expect(ok.ok, JSON.stringify(ok.content).slice(0, 400)).toBe(true);
    expectEnvelope(ok.content, true, `${name} ok`);
    // A change lands and reports the revision it made; a read, check or question changes nothing and reports the one
    // it read, with what it found beside it.
    const writes = MUTATING_TOOLS.has(name as never);
    expect(!!ok.mutated, `${name} changes the project`).toBe(writes);
    expect(session.revision).toBe(writes ? before + 1 : before);
    expect(ok.content.revision).toBe(session.revision);
    if (!writes) expect(Object.keys(ok.content).length, `${name} says what it found`).toBeGreaterThan(2);
    const at = session.revision;
    const bad = await executeTool(name, JSON.stringify(c.fail(session.state, session.revision, ids)), host, 'call_bad');
    expect(bad.ok).toBe(false);
    expectEnvelope(bad.content, false, `${name} fail`);
    expect(bad.content.revision).toBe(at);
    expect(bad.content.ok ? null : bad.content.error.code).toBe(c.code);
    // What the model receives parses back to the same result.
    expect(JSON.parse(serializeResult(bad.content, name))).toEqual(bad.content);
  });

  it.each(Object.keys(CASES) as ToolName[])('%s: a run sends its success and its failure to the model in the envelope', async (name) => {
    const c: Case = CASES[name];
    const { session, ids } = await sessionFor();
    await c.seed?.(session);
    const results = new Map<string, Extract<CanonicalItem, { kind: 'tool_result' }>>();
    const seen = (req: CanonicalModelRequest) => req.items.forEach((i) => i.kind === 'tool_result' && results.set(i.callId, i));
    const offered: string[][] = [];
    const turns: Array<(req: CanonicalModelRequest) => ModelEvent[]> = [
      (req) => {
        offered.push(req.tools.map((t) => t.name));
        const good: [string, string, unknown] = ['call_ok', name, c.ok(session.state, session.revision, ids)];
        return [c.sameStep ? calls(good, ['call_bad', name, (c.sameStep.fail ?? c.fail)(session.state, session.revision, ids)]) : call(...good)];
      },
      (req) => {
        seen(req);
        if (c.sameStep) return finish('Done.');
        offered.push(req.tools.map((t) => t.name));
        return [call('call_bad', name, c.fail(session.state, session.revision, ids))];
      },
      (req) => {
        seen(req);
        return finish('Done.');
      }
    ];
    const caps: Partial<ModelCapabilities> = c.where === 'design' ? { contextWindowTokens: 48_000, maxOutputTokens: 4000 } : {};
    const { run } = runner(session, turns, caps);
    const sel = selectionAt(session.state, c.where);
    await run('Go on', { selection: sel, selectionLabel: sel ? 'the selection' : null, ...(c.where === 'design' ? { component: { id: ids.design, name: 'Split hero' } } : {}), ...(c.where === 'ask' ? { mode: 'ask' as const } : {}), ...(c.where === 'layout' ? { template: { collectionId: 'posts', name: 'Posts' } } : {}) });
    // Offered at each call, so each result is the tool's own, never a refusal of a tool the step did not offer.
    for (const tools of offered) expect(tools, `${name} is offered ${c.where === 'site' ? 'to a site run' : `with ${c.where}`}`).toContain(name);
    const ok = results.get('call_ok')!;
    const bad = results.get('call_bad')!;
    expect(ok, 'the first result reached the model').toBeDefined();
    expect(bad, 'the second result reached the model').toBeDefined();
    const okBody = JSON.parse(ok.content);
    expectEnvelope(okBody, true, `${name} ok`);
    // A change's receipt may be its revision alone; a read, check or question says what it found.
    if (!MUTATING_TOOLS.has(name as never)) expect(Object.keys(okBody).length, `${name} says what it found`).toBeGreaterThan(2);
    else expect(okBody.revision, `${name} reports the revision it made`).toBeGreaterThan(0);
    expect(ok.isError).toBeFalsy();
    const badBody = JSON.parse(bad.content);
    expectEnvelope(badBody, false, `${name} fail`);
    expect(badBody.error.code, badBody.error.message).toBe(c.code);
    expect(bad.isError).toBe(true);
  });
});

class FakeAdapter implements AgentModelAdapter {
  requests: CanonicalModelRequest[] = [];
  constructor(
    private turns: Array<(req: CanonicalModelRequest) => ModelEvent[] | Promise<ModelEvent[]>>,
    private caps: Partial<ModelCapabilities> = {},
    private onTurn?: (n: number) => void
  ) {}
  capabilities() {
    return { toolCalling: 'native' as const, streaming: true, strictSchemas: false, parallelToolCalls: true, contextWindowTokens: 200000, maxOutputTokens: 32000, ...this.caps } as ModelCapabilities;
  }
  async *streamTurn(req: CanonicalModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent> {
    this.requests.push(structuredClone(req));
    this.onTurn?.(this.requests.length);
    const turn = this.turns.shift();
    for (const ev of turn ? await turn(req) : finish('Done.')) {
      if (signal.aborted) {
        yield { type: 'error', code: 'cancelled', message: 'Canceled' };
        return;
      }
      yield ev;
    }
  }
}

const call = (id: string, name: string, args: unknown): ModelEvent => ({ type: 'done', stopReason: 'tool_use', text: '', toolCalls: [{ id, name, arguments: JSON.stringify(args) }] });
const calls = (...list: Array<[string, string, unknown]>): ModelEvent => ({ type: 'done', stopReason: 'tool_use', text: '', toolCalls: list.map(([id, name, args]) => ({ id, name, arguments: JSON.stringify(args) })) });
const finish = (text: string): ModelEvent[] => [{ type: 'text', delta: text }, { type: 'done', stopReason: 'end', text, toolCalls: [] }];

/** A run over `session` with scripted turns; every question is answered with its first choice. */
function runner(session: ProjectSession, turns: Array<(req: CanonicalModelRequest) => ModelEvent[] | Promise<ModelEvent[]>>, caps: Partial<ModelCapabilities> = {}, extra: Partial<ConstructorParameters<typeof Orchestrator>[0]> = {}) {
  const adapter = new FakeAdapter(turns, caps);
  const events: AiEvent[] = [];
  const orch: Orchestrator = new Orchestrator({
    session: () => session,
    adapter: async () => ({ adapter, model: 'fake', provider: 'openai' }),
    emit: (e) => {
      events.push(e);
      const waiting = e.kind === 'message' ? e.message?.questions?.at(-1) : undefined;
      if (waiting?.id && waiting.answered === undefined) queueMicrotask(() => orch.answer(e.runId, waiting.id!, waiting.choices?.[0] ?? 'Yes'));
    },
    compileAll: async () => [],
    inspectLayout: async () => ({ issues: [], images: { total: 0, loaded: 0, failed: 0, unverified: 0 } }),
    inspectComponent: async (steps) => steps.map(measured),
    codeEnabled: async () => true,
    onBusyChange: () => undefined,
    sources: () => sourcesOf(session),
    controlPreview: previewAnswer,
    ...extra
  });
  const run = async (text: string, ctx: Partial<ChatContext> = {}) => {
    const r = await orch.send(text, { pageId: session.state.site.homePageId, pageTitle: 'Home', selection: null, selectionLabel: null, viewport: 1280, ...ctx });
    expect(r.ok).toBe(true);
    while (orch.busy) await new Promise((res) => setTimeout(res, 5));
    return { runId: r.runId!, result: [...events].reverse().find((e) => e.kind === 'message' && e.message?.result)?.message?.result };
  };
  return { adapter, orch, run, events };
}

/** The result of one call, as the model received it in a later request. */
const resultOf = (adapter: FakeAdapter, callId: string) => {
  for (const req of adapter.requests) {
    const item = req.items.find((i) => i.kind === 'tool_result' && i.callId === callId) as Extract<CanonicalItem, { kind: 'tool_result' }> | undefined;
    if (item) return { item, body: JSON.parse(item.content) as ToolResult };
  }
  throw new Error(`no result for ${callId}`);
};

describe("the orchestrator's own refusals in the envelope (#744)", () => {
  it('skips a second change in one step at the revision the first one made, recoverably', async () => {
    const { session } = await sessionFor();
    const page = session.state.site.homePageId;
    const { adapter, run } = runner(session, [
      () => [calls(['c1', 'apply_operations', { expectedRevision: 0, operations: [{ type: 'page.update', pageId: page, title: 'One' }] }], ['c2', 'apply_operations', { expectedRevision: 0, operations: [{ type: 'page.update', pageId: page, title: 'Two' }] }])],
      () => finish('Renamed it.')
    ]);
    await run('Rename Home');
    const first = resultOf(adapter, 'c1').body;
    const skipped = resultOf(adapter, 'c2');
    expect(first).toMatchObject({ ok: true, revision: 1 });
    expect(skipped.body).toEqual({ ok: false, revision: 1, error: { code: 'ONE_CHANGE_PER_TURN', message: expect.stringMatching(/^Skipped, not applied: .*send this change again in your next step, against the current revision \(1\)/), recoverable: true } });
    expect(skipped.item.isError).toBe(true);
    expect(home(session.state).title).toBe('One');
  });

  it('refuses a tool the step did not offer, and one that does not exist, at the revision the run reads', async () => {
    const { session } = await sessionFor();
    await session.apply({ operations: [{ type: 'page.update', pageId: session.state.site.homePageId, title: 'Before the run' }] }, { label: 'Rename', source: 'user' });
    const { adapter, run } = runner(session, [() => [calls(['c1', 'nothing_here', {}], ['c2', 'edit_selected_list', { prop: 'items', action: 'remove', itemId: 'x' }])], () => finish('Could not.')]);
    await run('Do something');
    for (const [id, tool] of [['c1', 'nothing_here'], ['c2', 'edit_selected_list']]) {
      const { item, body } = resultOf(adapter, id);
      expect(body).toEqual({ ok: false, revision: 1, error: { code: 'INVALID_ARGUMENT', message: `Unknown tool "${tool}".`, recoverable: true } });
      expect(item.isError).toBe(true);
    }
  });

  it('tells a question that a change it was never offered cannot be made in it', async () => {
    const { session } = await sessionFor();
    const { adapter, run } = runner(session, [() => [call('w1', 'update_site_brand', { siteName: 'From a question' })], () => finish('Nothing changed.')]);
    await run('Could the site be called something else?', { mode: 'ask' });
    expect(resultOf(adapter, 'w1').body).toEqual({ ok: false, revision: 0, error: { code: 'INVALID_ARGUMENT', message: 'Unknown tool "update_site_brand".', recoverable: false } });
    expect(session.state.site.name).not.toBe('From a question');
  });

  it('refuses every write a question sends in one step for good, never telling it to send the second again', async () => {
    const { session } = await sessionFor();
    const page = session.state.site.homePageId;
    const write = (title: string) => ({ expectedRevision: 0, operations: [{ type: 'page.update', pageId: page, title }] });
    const { adapter, run } = runner(session, [() => [calls(['w1', 'apply_operations', write('One')], ['w2', 'apply_operations', write('Two')])], () => finish('Nothing changed.')]);
    await run('Could Home be called something else?', { mode: 'ask' });
    for (const id of ['w1', 'w2']) expect(resultOf(adapter, id).body).toEqual({ ok: false, revision: 0, error: { code: 'INVALID_ARGUMENT', message: 'Unknown tool "apply_operations".', recoverable: false } });
    expect(session.revision).toBe(0);
  });

  it('refuses arguments that cannot even be named in a result, and carries on', async () => {
    const { session } = await sessionFor();
    const { adapter, run } = runner(session, [() => [call('r1', 'read_page', { pageId: { toString: 5 } })], () => finish('Could not read it.')]);
    const { result } = await run('Read the page');
    expect(resultOf(adapter, 'r1').body).toMatchObject({ ok: false, revision: 0, error: { code: 'INVALID_ARGUMENT', message: expect.stringContaining('pageId'), recoverable: true } });
    expect(result?.status).toBe('no-changes');
  });

  it('refuses a write in a question for good, at the revision the question read, though the project moved on', async () => {
    const { session } = await sessionFor();
    const page = session.state.site.homePageId;
    let moved = false;
    // A question is never offered a write: offered one anyway, the host's own guard is what refuses it.
    hooks.offer = ['apply_operations'];
    const { adapter, run } = runner(session, [
      async () => {
        // The author edits while the question runs: the question still reads the project as it was.
        await session.apply({ operations: [{ type: 'page.update', pageId: page, title: 'Edited meanwhile' }] }, { label: 'Rename', source: 'user' });
        moved = true;
        return [calls(['r1', 'read_component', { componentId: 'features.grid' }], ['w1', 'apply_operations', { expectedRevision: 0, operations: [{ type: 'page.update', pageId: page, title: 'From a question' }] }])];
      },
      () => finish('That is a question, so nothing changed.')
    ]);
    await run('What does the grid do?', { mode: 'ask' });
    expect(adapter.requests[0].tools.map((t) => t.name)).toContain('apply_operations');
    expect(moved).toBe(true);
    expect(session.revision).toBe(1);
    // A read the question made, which had no revision before, reports the one it read.
    expect(resultOf(adapter, 'r1').body).toMatchObject({ ok: true, revision: 0, definitionId: expect.any(String) });
    const refused = resultOf(adapter, 'w1');
    expect(refused.body).toEqual({ ok: false, revision: 0, error: { code: 'SCOPE_MISMATCH', message: expect.stringMatching(/^This is a read-only question: nothing on the site can be changed\./), recoverable: false } });
    expect(refused.item.isError).toBe(true);
    expect(home(session.state).title).toBe('Edited meanwhile');
  });

  it('refuses a change a stopped run had already sent, for good, and asks the model nothing more', async () => {
    const { session } = await sessionFor();
    const page = session.state.site.homePageId;
    await session.apply({ operations: [{ type: 'page.update', pageId: page, title: 'Before the run' }] }, { label: 'Rename', source: 'user' });
    let armed = false;
    const { adapter, run, orch } = runner(session, [
      () => {
        armed = true;
        return [call('w1', 'apply_operations', { expectedRevision: 1, operations: [{ type: 'page.update', pageId: page, title: 'Never' }] })];
      },
      () => finish('Unreachable.')
    ]);
    // Stopped just before the change reaches the project: apply_operations reads the diagnostics, then applies.
    const diagnostics = session.diagnostics.bind(session);
    session.diagnostics = () => {
      if (armed) {
        armed = false;
        orch.stop();
      }
      return diagnostics();
    };
    const { result } = await run('Rename Home');
    expect(result?.status).toBe('cancelled');
    expect(hooks.outcomes.find((o) => o.name === 'apply_operations')?.content).toEqual({ ok: false, revision: 1, error: { code: 'CANCELLED', message: 'Canceled', recoverable: false } });
    expect(adapter.requests).toHaveLength(1);
    expect(home(session.state).title).toBe('Before the run');
    expect(session.revision).toBe(1);
  });
});

describe('the result card (#744)', () => {
  it('keeps a component checked in every case a clean check when a later call asks past the last case', async () => {
    const { session } = await sessionFor();
    let finished = false;
    const step = (req: CanonicalModelRequest): ModelEvent[] => {
      const last = req.items.at(-1);
      const body = last?.kind === 'tool_result' ? (JSON.parse(last.content) as { ok: boolean; next?: { offset: number } }) : null;
      if (!body) return [call('c0', 'inspect_component', { componentId: 'features.grid' })];
      if (body.ok && body.next) return [call(`c${body.next.offset}`, 'inspect_component', { componentId: 'features.grid', offset: body.next.offset })];
      if (body.ok) return [call('past', 'inspect_component', { componentId: 'features.grid', offset: 999 })];
      finished = true;
      return finish('Checked.');
    };
    const { adapter, run } = runner(session, Array.from({ length: 30 }, () => step));
    const { result } = await run('Check the features grid in every case');
    expect(finished).toBe(true);
    expect(resultOf(adapter, 'past').body).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT', message: expect.stringContaining('past the last') } });
    expect(result?.checks).toContainEqual({ status: 'pass', text: expect.stringMatching(/has no layout or readability problems in its variants/) });
    expect(result?.checks?.filter((c) => /Only part of/.test(c.text))).toEqual([]);
  });
});

describe('a result cut to the size limit (#744)', () => {
  const big = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `n_${i}`, text: `Quote "${i}" \\ line\n ${'é😀'.repeat(20)}` }));
  const fits = (out: string) => {
    expect(out.length).toBeLessThanOrEqual(MAX_RESULT_CHARS);
    return JSON.parse(out) as Record<string, any>;
  };

  it('keeps ok, revision and every small field as fields, names what it cut, and fits whatever the text escapes to', () => {
    const result: ToolResult = { ok: true, revision: 7, owner: { kind: 'page', id: 'pg_a' }, sections: big(600), slotInfo: { a: 1 } };
    const body = fits(serializeResult(result, 'read_page'));
    expect(body).toMatchObject({ ok: true, revision: 7, owner: { kind: 'page', id: 'pg_a' }, slotInfo: { a: 1 }, truncated: true, leftOut: ['sections'], note: expect.stringContaining('read_page and its nodeId') });
    expect(body.partial.startsWith('{"sections":[{"id":"n_0"')).toBe(true);
    expect(body.partial.length).toBeGreaterThan(MAX_RESULT_CHARS / 3);
    // A change that landed is never sent again for the rest of its report.
    expect(fits(serializeResult(result, 'apply_operations', true)).note).toMatch(/applied.*Do not send the call again/);
  });

  it('keeps the hash of a source too long to show, so a patch can still be made', () => {
    const line = `<p>${'x'.repeat(30000)}</p>`;
    const body = fits(serializeResult({ ok: true, revision: 2, definitionId: 'proj.note', editable: true, hash: 'sha_abc', totalLines: 1, startLine: 1, endLine: 1, source: line }, 'read_source'));
    expect(body).toMatchObject({ definitionId: 'proj.note', hash: 'sha_abc', startLine: 1, endLine: 1, leftOut: ['source'] });
  });

  it('stays within the limit with a field name as long as a result, and names only what it cut', () => {
    const body = fits(serializeResult({ ok: true, revision: 1, ['k'.repeat(16000)]: 'v'.repeat(16000) }, 'read_project'));
    expect(body).toMatchObject({ ok: true, revision: 1, truncated: true, leftOut: [`${'k'.repeat(60)}…`] });
    // A whole message that happens to end the way a cut one does is never called cut.
    const failure = stamp(toolError('VALIDATION_FAILED', 'nodes[0]: odd… (cut)', { details: { fields: big(400) } }), 1).content as ToolResult;
    expect(fits(serializeResult(failure)).leftOut).toEqual(['error.details']);
  });

  it("keeps a failure's code, recoverable and the start of its message, and drops details first", () => {
    const failure = stamp(toolError('VALIDATION_FAILED', `sections[0]: ${'too long '.repeat(4000)}`, { details: { fields: big(400) } }), 3).content as ToolResult;
    const body = fits(serializeResult(failure, 'upsert_page_with_sections'));
    expect(body).toMatchObject({ ok: false, revision: 3, error: { code: 'VALIDATION_FAILED', recoverable: true, message: expect.stringMatching(/^sections\[0\]: too long .*… \(cut\)$/) }, truncated: true });
    expect(body.leftOut).toEqual(['error.message', 'error.details']);
    expect(body.error.details).toBeUndefined();
    expect(body.note).toMatch(/try again/);
    // One no call can get past is never sent back with advice to try again.
    const held = stamp(toolError('UPDATE_HELD', 'The header cannot be updated.', { details: { newVersionAdds: big(400) } }), 3).content as ToolResult;
    const said = fits(serializeResult(held, 'update_theme_component'));
    expect(said).toMatchObject({ ok: false, error: { code: 'UPDATE_HELD', recoverable: false, message: 'The header cannot be updated.' }, leftOut: ['error.details'] });
    expect(said.note).toMatch(/do not try it again/);
    expect(said.note).not.toMatch(/and try again/);
  });
});

describe('a repeated call (#744)', () => {
  it('gives back its first result, at the revision it was made, after the project moved on', async () => {
    const { session, ids } = await sessionFor();
    const host = hostFor(session, 'site', ids.design);
    const page = { slug: 'services', title: 'Services', sections: [{ componentId: 'intro.page', props: { heading: 'What we do', lead: 'Three clear services.' } }] };
    const first = await executeTool('upsert_page_with_sections', JSON.stringify(page), host, 'same');
    const rejected = await executeTool('upsert_page_with_sections', JSON.stringify(CASES.upsert_page_with_sections.fail()), host, 'other');
    await session.apply({ operations: [{ type: 'page.update', pageId: session.state.site.homePageId, title: 'Later' }] }, { label: 'Rename', source: 'user' });
    const pages = Object.keys(session.state.pages).length;
    expect(await executeTool('upsert_page_with_sections', JSON.stringify(page), host, 'same')).toEqual({ ok: true, content: first.content });
    expect(await executeTool('upsert_page_with_sections', JSON.stringify(CASES.upsert_page_with_sections.fail()), host, 'other')).toEqual({ ok: false, content: rejected.content });
    expect(Object.keys(session.state.pages)).toHaveLength(pages);
    expect(first.content.revision).toBe(1);
    expect(rejected.content.revision).toBe(1);
    // The same call ID sent with something else is refused at the revision now.
    expect((await executeTool('upsert_page_with_sections', JSON.stringify({ ...page, title: 'Other' }), host, 'same')).content).toMatchObject({ ok: false, revision: 2, error: { code: 'INVALID_ARGUMENT' } });
  });

  it('gives back a rejected component build as it was, at the revision it was rejected at', async () => {
    const { session, ids } = await sessionFor();
    const host = hostFor(session, 'site', ids.design);
    const bad = CASES.upsert_managed_component.fail();
    const first = await executeTool('upsert_managed_component', JSON.stringify(bad), host, 'm1');
    expect(first.content).toMatchObject({ ok: false, revision: 0, error: { code: 'VALIDATION_FAILED' } });
    await session.apply({ operations: [{ type: 'page.update', pageId: session.state.site.homePageId, title: 'Later' }] }, { label: 'Rename', source: 'user' });
    expect(await executeTool('upsert_managed_component', JSON.stringify(bad), host, 'm1')).toEqual({ ok: false, content: first.content });
  });
});

describe('a collapsed read (#744)', () => {
  it('stays a result, with ok and the revision it was read at', () => {
    const page = (rev: number) => JSON.stringify({ ok: true, revision: rev, id: 'pg_a', title: 'Home', sections: Array.from({ length: 40 }, (_, i) => ({ id: `n_${i}`, componentId: 'hero.split', props: { heading: 'x'.repeat(200) } })) });
    const read = (id: string, rev: number): CanonicalItem[] => [
      { kind: 'assistant', text: '', toolCalls: [{ id, name: 'read_page', arguments: JSON.stringify({ pageId: 'pg_a' }) }] },
      { kind: 'tool_result', callId: id, name: 'read_page', content: page(rev) }
    ];
    const items: CanonicalItem[] = [{ kind: 'user', text: 'go' }, ...read('a', 4), ...read('b', 5), { kind: 'assistant', text: 'x', toolCalls: [] }, { kind: 'user', text: 'more' }, { kind: 'assistant', text: 'y', toolCalls: [] }];
    const r = applyContextBudget(items, { system: 'sys', tools: [], capabilities: { contextWindowTokens: 7000, maxOutputTokens: 500 }, isMutation: () => false });
    expect(r.tombstoned).toBe(1);
    const collapsed = JSON.parse((items[2] as { content: string }).content);
    expect(collapsed).toEqual({ ok: true, revision: 4, superseded: expect.stringMatching(/^read_page pg_a "Home" at rev 4\. Sections: n_0 hero\.split/) });
    // Collapsed once, it is never collapsed again, however tight the window gets.
    const once = (items[2] as { content: string }).content;
    expect(applyContextBudget(items, { system: 'sys', tools: [], capabilities: { contextWindowTokens: 3000, maxOutputTokens: 500 }, isMutation: () => false }).tombstoned).toBe(0);
    expect((items[2] as { content: string }).content).toBe(once);
  });
});

describe('failures every tool shares (#744)', () => {
  it('refuses an unknown tool, malformed arguments and a reserved ID in the envelope, at the revision the call read', async () => {
    const { session, ids } = await sessionFor();
    await session.apply({ operations: [{ type: 'page.update', pageId: session.state.site.homePageId, title: 'Moved on' }] }, { label: 'Rename', source: 'user' });
    const host = hostFor(session, 'site', ids.design);
    const refused = async (name: string, args: string) => (await executeTool(name, args, host, 'c')).content;
    expect(await refused('nothing_here', '{}')).toEqual({ ok: false, revision: 1, error: { code: 'INVALID_ARGUMENT', message: 'Unknown tool "nothing_here".', recoverable: true } });
    // An inherited name is no tool, and no component either: refused, never a crash that ends the run.
    expect(await refused('constructor', '{}')).toMatchObject({ ok: false, revision: 1, error: { code: 'INVALID_ARGUMENT', message: 'Unknown tool "constructor".' } });
    expect(await refused('read_component', JSON.stringify({ definitionId: 'constructor' }))).toMatchObject({ ok: false, revision: 1, error: { code: 'INVALID_ARGUMENT', message: 'Component not found. Use search_components.' } });
    expect(await refused('read_source', JSON.stringify({ definitionId: 'constructor' }))).toMatchObject({ ok: false, revision: 1, error: { code: 'INVALID_ARGUMENT', message: 'Unknown component.' } });
    expect(await refused('read_page', '{"pageId": ')).toEqual({ ok: false, revision: 1, error: { code: 'INVALID_ARGUMENT', message: 'Arguments were not valid JSON.', recoverable: true } });
    expect(await refused('apply_operations', JSON.stringify({ expectedRevision: 1, operations: [{ type: 'page.create', title: 'Shop', pageId: 'pg_mine' }] }))).toEqual({ ok: false, revision: 1, error: { code: 'INVALID_ARGUMENT', message: 'page.create does not take a pageId.', recoverable: true } });
    expect(session.revision).toBe(1);
  });

  it("reports a refused change at the revision the session says, with the session's own error", async () => {
    const { session, ids } = await sessionFor();
    const host: ToolHost = { ...hostFor(session, 'site', ids.design), revision: () => 5, apply: async () => ({ ok: false, revision: 9, error: { code: 'CONFLICT', message: 'Resolve the file conflicts first.', recoverable: false, details: { files: ['a.svelte'] } } }) };
    const out = await executeTool('apply_source_patch', JSON.stringify(CASES.apply_source_patch.ok(session.state, 5, ids)), host, 'p1');
    expect(out.content).toEqual({ ok: false, revision: 9, error: { code: 'CONFLICT', message: 'Resolve the file conflicts first.', recoverable: false, details: { files: ['a.svelte'] } } });
    // What a tool adds goes after the session's words, which it keeps.
    expect(applyFailure({ revision: 4, error: { code: 'INVALID_ARGUMENT', message: 'Page "/a/" does not exist.', recoverable: true } }, 'Create it first.').content).toEqual({ revision: 4, error: { code: 'INVALID_ARGUMENT', message: 'Page "/a/" does not exist. Create it first.', recoverable: true } });
  });

  it('says a call can be corrected or sent later only where one can', () => {
    const recoverable = Object.fromEntries(TOOL_ERROR_CODES.map((code) => [code, (toolError(code, 'x').content as { error: { recoverable: boolean } }).error.recoverable]));
    expect(recoverable).toEqual({ INVALID_ARGUMENT: true, STALE_REVISION: true, SCOPE_MISMATCH: true, PATH_DENIED: false, VALIDATION_FAILED: true, CONFLICT: false, CANCELLED: false, BUSY: true, ONE_CHANGE_PER_TURN: true, UPDATE_HELD: false, SAVE_FAILED: false });
    // The place that refuses can say otherwise.
    expect((toolError('SCOPE_MISMATCH', 'x', { recoverable: false }).content as { error: { recoverable: boolean } }).error.recoverable).toBe(false);
  });
});
