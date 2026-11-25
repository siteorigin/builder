import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkCoverage, declaredSteps } from '../coverage/check';
import type { CoverageInput } from '../coverage/check';
import { AREAS, GAP_ISSUES, INTERACTIONS, toMarkdown } from '../coverage/interactions';
import type { Area, Interaction } from '../coverage/interactions';
import { commands, leftTabs, menuItems, nativeMenu, ROOT, shortcuts, surfaces, texts, writingMenu } from '../coverage/surfaces';
import ts from 'typescript';
import type { MenuItemConstructorOptions } from 'electron';
import { appMenuTemplate } from '../../src/main/app-menu';

const read = (p: string) => (existsSync(join(ROOT, p)) ? readFileSync(join(ROOT, p), 'utf8') : null);
/** Scripts that are helpers, or capture screens only, rather than prove behaviour. */
const NOT_PROOFS = new Set(['harness.mjs', 'design-capture.mjs']);
const e2e = readdirSync(join(ROOT, 'tests/e2e'))
  .filter((f) => f.endsWith('.mjs') && !NOT_PROOFS.has(f))
  .map((f) => `tests/e2e/${f}`);
const areas = Object.keys(AREAS) as Area[];

describe('the interaction inventory (issue #498)', () => {
  it('covers every discoverable action, links every e2e script, and names only tests and steps that exist', () => {
    const problems = checkCoverage({ rows: INTERACTIONS, surfaces: surfaces(), areas, e2e, read, issues: GAP_ISSUES });
    expect(problems).toEqual([]);
  });

  it('prints as one table per area', () => {
    const md = toMarkdown();
    for (const title of Object.values(AREAS)) expect(md).toContain(`## ${title}`);
    expect(md.split('\n').filter((l) => l.startsWith('| ') && !l.startsWith('| Intent') && !l.startsWith('| ---'))).toHaveLength(INTERACTIONS.length);
  });
});

describe('what the readers find in the app', () => {
  it('lists the application menu for each platform, with what only some platforms have', () => {
    const menu = new Map(nativeMenu().map((s) => [s.key, s.platforms]));
    expect(menu.get('menu:File > New Project…')).toEqual(['darwin', 'win32', 'linux']);
    expect(menu.get('menu:File > Open Project Folder…')).toEqual(['win32', 'linux']);
    expect(menu.get('menu:Edit > Undo')).toEqual(['darwin', 'win32', 'linux']);
    expect(menu.get('role:appMenu')).toEqual(['darwin']);
    expect(menu.get('role:quit')).toEqual(['win32', 'linux']);
    expect(menu.get('role:startSpeaking')).toEqual(['darwin']);
  });

  it('keeps each platform’s accelerators: Redo on Ctrl+Y on Windows, Shift+Cmd/Ctrl+Z elsewhere', () => {
    const redo = (p: NodeJS.Platform) => (appMenuTemplate(p, true, { command: () => undefined, history: () => () => undefined }).find((m) => m.label === 'Edit')!.submenu as MenuItemConstructorOptions[]).find((i) => i.id === 'edit-redo')!.accelerator;
    expect([redo('win32'), redo('darwin'), redo('linux')]).toEqual(['Control+Y', 'Shift+CommandOrControl+Z', 'Shift+CommandOrControl+Z']);
    // Export and Close Project are offered only with a project open.
    const file = (open: boolean) => (appMenuTemplate('darwin', open, { command: () => undefined, history: () => () => undefined }).find((m) => m.label === 'File')!.submenu as MenuItemConstructorOptions[]).filter((i) => i.id).map((i) => [i.id, i.enabled]);
    expect([file(true), file(false)]).toEqual([
      [['export', true], ['close-project', true]],
      [['export', false], ['close-project', false]]
    ]);
  });

  it('lists the writing menu, the command menu, the sidebar and the shortcut keys', () => {
    // Read from the template for right spelling, a misspelling with suggestions, and one with none.
    expect(writingMenu().map((s) => s.key).sort()).toEqual(['writing:<suggestion>', 'writing:Copy', 'writing:Cut', 'writing:No spelling suggestions', 'writing:Paste', 'writing:Select All']);
    const cmds = commands().map((s) => s.key);
    for (const k of ['command:newproject', 'command:find', 'command:page:*', 'command:panel:*', 'command:Insert:*', 'command:sec:*:*']) expect(cmds).toContain(k);
    expect(leftTabs().map((s) => s.key)).toEqual(expect.arrayContaining(['tab:pages', 'tab:layers', 'tab:insert', 'tab:assets']));
    expect(shortcuts().map((s) => s.key)).toEqual(expect.arrayContaining(['key:z', 'key:k', 'key:Escape', 'key:Delete']));
    const items = menuItems().items.map((s) => s.key);
    for (const k of ['item:Canvas:Edit text', 'item:Layers:Select *', 'item:Pages:Make home page…', 'item:WrapItems:Wrap* in *']) expect(items).toContain(k);
  });

  it('reads a label as every text it can be, with * for what comes from data', () => {
    const expr = (src: string) => (ts.createSourceFile('x.ts', `x = ${src}`, ts.ScriptTarget.Latest, true).statements[0] as ts.ExpressionStatement).expression as ts.BinaryExpression;
    expect(texts(expr("'Delete'").right)).toEqual(['Delete']);
    expect(texts(expr('a ? `Move ${n}` : "To the end"').right)).toEqual(['Move *', 'To the end']);
    expect(texts(expr('`Wrap${what} in ${name}`').right)).toEqual(['Wrap* in *']);
    expect(texts(expr("label || 'Untitled'").right)).toEqual(['Untitled']);
    expect(texts(expr('item.label').right)).toBeNull();
  });
});

describe('checkCoverage', () => {
  const row = (over: Partial<Interaction> = {}): Interaction => ({
    id: 'projects.create',
    area: 'projects',
    intent: 'Make a site',
    start: 'Welcome',
    routes: ['menu:File > New Project…'],
    outcome: 'A project opens',
    scenario: 'welcome · scripted',
    proof: [{ test: 'tests/e2e/a.mjs', kind: 'driver', step: 'creates it' }],
    ...over
  });
  const files: Record<string, string> = {
    'tests/e2e/a.mjs': "step('creates it');\nstep('creates it again, twice');\n// step('only in a comment')",
    'tests/e2e/b.mjs': '',
    'tests/e2e/tour.mjs': '',
    'tests/unit/a.test.ts': "it('reads it', () => {});"
  };
  const base = (over: Partial<CoverageInput> = {}): CoverageInput => ({
    rows: [row()],
    surfaces: [{ key: 'menu:File > New Project…', file: 'src/main/app-menu.ts', platforms: ['darwin', 'win32', 'linux'] }],
    areas: ['projects'],
    e2e: ['tests/e2e/a.mjs'],
    read: (p) => files[p] ?? null,
    issues: { 489: 'epic' },
    ...over
  });

  it('passes a list that covers everything', () => {
    expect(checkCoverage(base())).toEqual([]);
  });

  it('fails an action no row routes to, naming where it is defined', () => {
    const problems = checkCoverage(base({ surfaces: [...base().surfaces, { key: 'command:new-thing', file: 'src/renderer/src/panels/CommandMenu.tsx:300' }] }));
    expect(problems).toEqual(['No row has the route "command:new-thing" (defined at src/renderer/src/panels/CommandMenu.tsx:300). Add it to the row for what it does, or add a row (tests/coverage/interactions.ts).']);
  });

  it('fails a route to an action the app no longer has, and a route of no known kind', () => {
    const problems = checkCoverage(base({ rows: [row({ routes: ['menu:File > New Project…', 'command:gone', 'somewhere:else'] })] }));
    expect(problems).toHaveLength(2);
    expect(problems[0]).toMatch(/route "command:gone" is not an action of the app any more/);
    expect(problems[1]).toMatch(/route "somewhere:else" starts with one of/);
    // A described route names its control.
    expect(checkCoverage(base({ rows: [row({ routes: ['menu:File > New Project…', 'toolbar:   '] })] }))).toEqual([expect.stringMatching(/route "toolbar:   " starts with one of/)]);
  });

  it('fails a proof that does not exist, a step it does not declare, and an e2e script no row links', () => {
    const problems = checkCoverage(
      base({
        rows: [row({ proof: [{ test: 'tests/e2e/a.mjs', kind: 'driver', step: 'creates it' }, { test: 'tests/e2e/a.mjs', kind: 'driver', step: 'a step that is not there' }, { test: 'tests/e2e/gone.mjs', kind: 'e2e' }] })],
        e2e: ['tests/e2e/a.mjs', 'tests/e2e/b.mjs']
      })
    );
    expect(problems).toEqual([
      'Row projects.create: tests/e2e/a.mjs declares no step "a step that is not there".',
      'Row projects.create: its proof tests/e2e/gone.mjs does not exist.',
      'No row links tests/e2e/b.mjs: add it as a proof of the rows it proves.'
    ]);
  });

  it('takes a step only as part of exactly one declared title, never from a comment, and needs one for a behaviour proof', () => {
    const steps = (step?: string, kind: 'driver' | 'unit' = 'driver', test = kind === 'unit' ? 'tests/unit/a.test.ts' : 'tests/e2e/a.mjs') => checkCoverage(base({ rows: [row({ proof: [{ test: 'tests/e2e/a.mjs', kind: 'driver', step: 'creates it again' }, { test, kind, ...(step ? { step } : {}) }] })] }));
    expect(steps('only in a comment')).toEqual(['Row projects.create: tests/e2e/a.mjs declares no step "only in a comment".']);
    expect(steps('creates')).toEqual(['Row projects.create: "creates" is part of 2 steps of tests/e2e/a.mjs; name the one that proves it.']);
    expect(steps()).toEqual(['Row projects.create: name the step of tests/e2e/a.mjs that proves it.']);
    // A unit test may be linked as a whole; a named one must be declared.
    expect(steps(undefined, 'unit')).toEqual([]);
    expect(steps('reads it', 'unit')).toEqual([]);
    expect(steps('reads nothing', 'unit')).toEqual(['Row projects.create: tests/unit/a.test.ts declares no step "reads nothing".']);
    expect(declaredSteps('x.mjs', "step(`${name}: made per case`); it(\"plain\"); // step('no')")).toEqual(['*: made per case', 'plain']);
  });

  it('fails a proof kind that does not fit its file, and a row only screen captures prove', () => {
    expect(checkCoverage(base({ rows: [row({ proof: [row().proof[0], { test: 'tests/e2e/b.mjs', kind: 'unit' }] })], e2e: ['tests/e2e/a.mjs', 'tests/e2e/b.mjs'] }))).toEqual([
      'Row projects.create: a unit proof lives in tests/unit/*.test.ts, not tests/e2e/b.mjs.',
      // Linked only as a unit test, b.mjs is still not linked as the script it is.
      'No row links tests/e2e/b.mjs: add it as a proof of the rows it proves.'
    ]);
    expect(checkCoverage(base({ rows: [row(), row({ id: 'projects.tour', proof: [{ test: 'tests/e2e/tour.mjs', kind: 'design' }] })] }))).toEqual([
      'Row projects.tour: its only proofs capture screens; add a proof that checks the outcome, or a gap with its owner.'
    ]);
  });

  it('fails a row with neither proof nor owned gap, and accepts one with an owned gap', () => {
    expect(checkCoverage(base({ rows: [row({ proof: [] })], e2e: [] }))).toEqual(['Row projects.create: it has neither a proof nor a gap with its owner.']);
    expect(checkCoverage(base({ rows: [row({ proof: [], gaps: [{ missing: 'An e2e of it', owner: 'projects', issue: 489 }] })], e2e: [] }))).toEqual([]);
    expect(checkCoverage(base({ rows: [row({ proof: [], gaps: [{ missing: 'An e2e of it', owner: 'projects', issue: 1 }] })], e2e: [] }))).toEqual(['Row projects.create: gap issue #1 is not one of the open issues listed in GAP_ISSUES.']);
  });

  it('fails packaged credit without a packaged test, and a row claiming platforms none of its routes reach', () => {
    expect(checkCoverage(base({ rows: [row({ builds: ['dev', 'packaged'] })] }))).toEqual(['Row projects.create: it says it is proven on the packaged build, but no packaged test proves it.']);
    expect(checkCoverage(base({ rows: [row({ proof: [{ test: 'tests/e2e/a.mjs', kind: 'packaged' }] })] }))).toEqual(['Row projects.create: tests/e2e/a.mjs does not run the packaged app, so it cannot prove a packaged build.']);
    const folder = { key: 'menu:File > Open Project Folder…', file: 'src/main/app-menu.ts', platforms: ['win32', 'linux'] as ('win32' | 'linux')[] };
    expect(checkCoverage(base({ surfaces: [...base().surfaces, folder], rows: [row(), row({ id: 'projects.folder', routes: [folder.key] })] }))).toEqual([
      'Row projects.folder: it applies to darwin, where none of its routes exist. List its platforms.'
    ]);
    expect(checkCoverage(base({ surfaces: [...base().surfaces, folder], rows: [row(), row({ id: 'projects.folder', routes: [folder.key], platforms: ['win32', 'linux'] })] }))).toEqual([]);
  });

  it('fails an area with no row and a repeated id', () => {
    expect(checkCoverage(base({ areas: ['projects', 'pages'] }))).toEqual(['No row covers the area "pages".']);
    expect(checkCoverage(base({ rows: [row(), row()] }))).toEqual(['Row projects.create: the id is used by another row.']);
  });
});
