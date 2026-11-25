/**
 * Holds the interaction inventory (interactions.ts) to the app and its tests (issue #498). Pure: the caller passes the
 * rows, the actions the readers found (surfaces.ts), and how to read a file, and gets back every problem, each saying
 * what to do about it.
 */
import ts from 'typescript';
import type { Area, Interaction, ProofKind } from './interactions.ts';
import { ENFORCED_PREFIXES } from './surfaces.ts';
import type { Surface } from './surfaces.ts';

export interface CoverageInput {
  rows: Interaction[];
  surfaces: Surface[];
  areas: readonly Area[];
  /** The e2e scripts every one of which a row must link (from the repository root). */
  e2e: string[];
  /** A file's text, or null when it does not exist. */
  read: (path: string) => string | null;
  /** Open issues gaps may name. */
  issues: Record<number, string>;
}

/** Route prefixes that name a control in words, unchecked against the source. */
export const DESCRIBED_PREFIXES = ['welcome', 'toolbar', 'panel', 'inspector', 'canvas', 'preview', 'chat', 'dialog', 'status'] as const;

/** Tests that run the packaged app. */
const PACKAGED_TESTS = new Set(['tests/e2e/packaged.mjs', 'tests/e2e/linux-container.mjs']);

/** Where each kind of proof lives. */
const PROOF_PLACES: Record<ProofKind, RegExp> = {
  driver: /^(tests\/e2e\/[\w-]+\.mjs|scripts\/model-smoke\.mjs)$/,
  e2e: /^tests\/e2e\/[\w-]+\.mjs$/,
  design: /^tests\/e2e\/(design\/)?[\w-]+\.mjs$/,
  packaged: /^tests\/e2e\/[\w-]+\.mjs$/,
  unit: /^tests\/unit\/[\w.-]+\.test\.ts$/
};
/** Proofs that drive the app the way a person does: the ones that link an e2e script. */
const BEHAVIOUR: ReadonlySet<ProofKind> = new Set(['driver', 'e2e', 'packaged']);

/** The titles a test file declares: the first argument of each step(), it(), test() and describe() call, as written (* for a part made per case). */
export function declaredSteps(path: string, text: string): string[] {
  const sf = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, false, path.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS);
  const out: string[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n)) {
      const callee = ts.isIdentifier(n.expression) ? n.expression.text : ts.isPropertyAccessExpression(n.expression) && ts.isIdentifier(n.expression.expression) ? n.expression.expression.text : '';
      const first = n.arguments[0];
      if (['step', 'it', 'test', 'describe'].includes(callee) && first) {
        if (ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first)) out.push(first.text);
        // A title made for each case (`${starter}: ...`): its fixed words, with * where each case's go.
        else if (ts.isTemplateExpression(first)) out.push(first.head.text + first.templateSpans.map((t) => `*${t.literal.text}`).join(''));
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

export function checkCoverage(input: CoverageInput): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();
  const routed = new Set<string>();
  const linked = new Set<string>();
  const known = new Map(input.surfaces.map((s) => [s.key, s]));
  const steps = new Map<string, string[]>();
  const stepsOf = (path: string, text: string) => steps.get(path) ?? steps.set(path, declaredSteps(path, text)).get(path)!;
  const prefixOf = (route: string) => route.slice(0, route.indexOf(':'));
  for (const r of input.rows) {
    const at = `Row ${r.id}`;
    if (!/^[a-z][a-z-]*\.[a-z0-9][a-z0-9.-]*$/.test(r.id)) problems.push(`${at}: its id is "area.what" in lower case.`);
    if (ids.has(r.id)) problems.push(`${at}: the id is used by another row.`);
    ids.add(r.id);
    if (!input.areas.includes(r.area)) problems.push(`${at}: unknown area "${r.area}".`);
    for (const [k, v] of [['intent', r.intent], ['start', r.start], ['outcome', r.outcome], ['scenario', r.scenario]] as const) if (!v?.trim()) problems.push(`${at}: it needs ${k === 'outcome' ? 'an' : 'a'} ${k}.`);
    if (!r.routes.length) problems.push(`${at}: it needs at least one route a person can find.`);
    for (const route of r.routes) {
      const p = prefixOf(route);
      if ((ENFORCED_PREFIXES as readonly string[]).includes(p)) {
        if (!known.has(route)) problems.push(`${at}: route "${route}" is not an action of the app any more (tests/coverage/surfaces.ts finds no such ${p}). Remove it, or name the action as it is now.`);
        routed.add(route);
      } else if (!(DESCRIBED_PREFIXES as readonly string[]).includes(p) || !route.slice(p.length + 1).trim()) problems.push(`${at}: route "${route}" starts with one of ${[...ENFORCED_PREFIXES, ...DESCRIBED_PREFIXES].map((x) => `${x}:`).join(' ')}.`);
    }
    // An owned gap stands for a missing proof.
    if (!r.proof.length && !r.gaps?.length) problems.push(`${at}: it has neither a proof nor a gap with its owner.`);
    // A row proven only by screen captures still needs an owned gap: a capture checks no outcome.
    if (r.proof.length && r.proof.every((p) => p.kind === 'design') && !r.gaps?.length) problems.push(`${at}: its only proofs capture screens; add a proof that checks the outcome, or a gap with its owner.`);
    for (const p of r.proof) {
      if (BEHAVIOUR.has(p.kind) || p.kind === 'design') linked.add(p.test);
      if (!PROOF_PLACES[p.kind]?.test(p.test)) problems.push(`${at}: a ${p.kind} proof lives in ${p.kind === 'unit' ? 'tests/unit/*.test.ts' : 'tests/e2e/*.mjs'}, not ${p.test}.`);
      const text = input.read(p.test);
      if (text === null) {
        problems.push(`${at}: its proof ${p.test} does not exist.`);
        continue;
      }
      const titles = stepsOf(p.test, text);
      if (p.step) {
        // The step is a title the file declares, or part of exactly one: not a comment, and not shared by several steps.
        const hits = titles.includes(p.step) ? [p.step] : titles.filter((t) => t.includes(p.step!));
        if (!hits.length) problems.push(`${at}: ${p.test} declares no step "${p.step}".`);
        else if (hits.length > 1) problems.push(`${at}: "${p.step}" is part of ${hits.length} steps of ${p.test}; name the one that proves it.`);
      } else if ((p.kind === 'driver' || p.kind === 'e2e') && titles.length) problems.push(`${at}: name the step of ${p.test} that proves it.`);
      if (p.kind === 'packaged' && !PACKAGED_TESTS.has(p.test)) problems.push(`${at}: ${p.test} does not run the packaged app, so it cannot prove a packaged build.`);
    }
    if (r.builds?.includes('packaged') && !r.proof.some((p) => p.kind === 'packaged')) problems.push(`${at}: it says it is proven on the packaged build, but no packaged test proves it.`);
    for (const g of r.gaps ?? []) {
      if (!g.missing?.trim() || !g.owner?.trim()) problems.push(`${at}: each gap says what is missing and who owns it.`);
      if (g.issue !== undefined && !input.issues[g.issue]) problems.push(`${at}: gap issue #${g.issue} is not one of the open issues listed in GAP_ISSUES.`);
    }
    if (r.platforms && !r.platforms.length) problems.push(`${at}: leave out platforms rather than listing none.`);
    // A row whose only routes exist on some platforms says so.
    const menuPlatforms = r.routes.map((route) => known.get(route)?.platforms).filter((x): x is NonNullable<typeof x> => !!x);
    if (menuPlatforms.length && menuPlatforms.length === r.routes.length) {
      const reach = new Set(menuPlatforms.flat());
      const claimed = r.platforms ?? ['darwin', 'win32', 'linux'];
      const beyond = claimed.filter((p) => !reach.has(p));
      if (beyond.length) problems.push(`${at}: it applies to ${beyond.join(', ')}, where none of its routes exist. List its platforms.`);
    }
  }
  for (const s of input.surfaces) if (!routed.has(s.key)) problems.push(`No row has the route "${s.key}" (defined at ${s.file}). Add it to the row for what it does, or add a row (tests/coverage/interactions.ts).`);
  for (const a of input.areas) if (!input.rows.some((r) => r.area === a)) problems.push(`No row covers the area "${a}".`);
  for (const f of input.e2e) if (!linked.has(f)) problems.push(`No row links ${f}: add it as a proof of the rows it proves.`);
  return problems;
}
