// The layout inspection's readability checks against the real app (#361): a page built through operations gets
// low-contrast text in one card, overlapping boxes, text cut off by its box and a small tap target; the inspection
// the assistant runs (main process → hidden preview frame → bridge → editor) reports each one with the reference
// operations take, an operation given that reference fixes it, and the page inspected again reports nothing.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createProject, launch, scratch, step, withTimeout } from './harness.mjs';

const { WORK, cleanup } = scratch('inspect-layout');
const { app, win, errors } = await launch(WORK);
await createProject(win, { name: 'Readable Rooms', parentDir: join(WORK, 'sites'), starter: 'blank', sampleImages: false });

const snapshot = () => win.evaluate(async () => (await window.builder.project.snapshot()).state);
const apply = (operations, label) =>
  win.evaluate(async ([operations, label]) => {
    const r = await window.builder.project.apply({ operations, label });
    if (!r.ok) throw new Error(`${label}: ${r.error?.message}`);
    return r.results;
  }, [operations, label]);
const READABILITY = ['low-contrast', 'overlap', 'clipped-text', 'small-tap-target', 'contrast-unverified'];
/** The page measured at phone width, as inspect_layout measures it; the preview is given time to catch up first. */
const inspect = async () => {
  const report = await withTimeout(win.evaluate(([id]) => window.builderTest.inspectLayout(id, 390), [pageId]), 90000, 'Layout inspection');
  assert.ok(report && !report.error, `the inspection ran: ${JSON.stringify(report)}`);
  return report;
};
/** Inspect until `check` holds: the preview rebuilds after each change in its own time. */
const inspectUntil = async (check, what) => {
  let last;
  for (let i = 0; i < 8; i++) {
    last = await inspect();
    try {
      check(last);
      return last;
    } catch {
      await new Promise((r) => setTimeout(r, 750));
    }
  }
  check(last);
  throw new Error(`${what}: ${JSON.stringify(last)}`);
};
const findings = (report) => report.issues.filter((i) => READABILITY.includes(i.kind));
const summary = (report) => JSON.stringify({ checks: report.checks, findings: findings(report) }, null, 1);

const pageId = (await snapshot()).site.homePageId;
const owner = { kind: 'page', id: pageId };

try {
  step('a page with a card grid, a grid of panels, a short story box and a button');
  const [{ nodeId: section }] = await apply([{ type: 'node.insert', owner, componentId: 'layout.section' }], 'Insert section');
  const [{ nodeId: stack }] = await apply([{ type: 'node.insert', owner, parentId: section, slot: 'content', primitive: 'stack' }], 'Insert stack');
  await apply([{ type: 'node.insert', owner, parentId: stack, primitive: 'heading', text: 'Readable rooms' }], 'Insert heading');
  const [{ nodeId: storyBox }] = await apply([{ type: 'node.insert', owner, parentId: stack, primitive: 'container' }], 'Insert story box');
  await apply([{ type: 'node.insert', owner, parentId: storyBox, primitive: 'paragraph', text: 'Every room starts with a walk through it at different times of day, so the plan follows the light and the way the household really lives, from breakfast to the last lamp at night.' }], 'Insert story');
  const [{ nodeId: panels }] = await apply([{ type: 'node.insert', owner, parentId: stack, primitive: 'grid' }], 'Insert panel grid');
  const [{ nodeId: wide }] = await apply([{ type: 'node.insert', owner, parentId: panels, primitive: 'container' }], 'Insert wide panel');
  await apply([{ type: 'node.insert', owner, parentId: wide, primitive: 'paragraph', text: 'Wide panel' }], 'Insert wide text');
  const [{ nodeId: next }] = await apply([{ type: 'node.insert', owner, parentId: panels, primitive: 'container' }], 'Insert next panel');
  await apply([{ type: 'node.insert', owner, parentId: next, primitive: 'paragraph', text: 'Next panel' }], 'Insert next text');
  const [{ nodeId: button }] = await apply([{ type: 'node.insert', owner, parentId: stack, primitive: 'button', text: 'Go' }], 'Insert button');
  // A button with nowhere to go is shown only while editing: visitors (and the inspection) never see it.
  await apply([{ type: 'node.setContent', owner, nodeId: button, field: 'link', value: { type: 'page', target: pageId } }], 'Link the button');
  const [{ nodeId: grid }] = await apply([{ type: 'node.insert', owner, parentId: stack, componentId: 'features.grid' }], 'Insert features');
  const cards = (await snapshot()).pages[pageId].nodes[grid].props.items;
  assert.ok(cards?.length >= 2, 'the features grid has cards');
  const card = cards[1].id;

  // The theme's shared header and footer have links under 44px tall at phone width: reported on the shell, each on
  // the placement that holds it there.
  const state = await snapshot();
  const shellPlacement = (part) => state.site.shell[part].rootIds[0];
  const withShell = await inspectUntil((r) => assert.ok(r.checks, 'the report counts the readability checks'), 'with the shell');
  const shell = findings(withShell);
  assert.deepEqual([...new Set(shell.map((f) => f.ref?.owner.id))].sort(), ['footer', 'header'], `the header's and the footer's links are measured:\n${summary(withShell)}`);
  for (const f of shell) {
    assert.equal(f.kind, 'small-tap-target', summary(withShell));
    assert.ok(['header', 'footer'].includes(f.ref?.owner.id) && f.ref.owner.kind === 'shell', summary(withShell));
    assert.equal(f.ref.nodeId, shellPlacement(f.ref.owner.id), `named on the ${f.ref.owner.id}'s placement`);
    assert.ok(f.ref.match, 'a link inside the shell is named by the part around it, and says so');
  }
  assert.equal(withShell.checks.tapTargets.failed, shell.reduce((n, f) => n + (f.count ?? 1), 0), summary(withShell));

  step('without the shell, the page itself starts readable');
  await apply([{ type: 'page.update', pageId, showHeader: false, showFooter: false }], 'Hide the shell');
  const baseline = await inspectUntil((r) => assert.deepEqual(findings(r), []), 'the page without its shell is clean');
  for (const [name, c] of Object.entries(baseline.checks)) assert.deepEqual([c.failed, c.unverified, c.incomplete], [0, 0, undefined], `${name} starts clean:\n${summary(baseline)}`);
  assert.ok(baseline.checks.contrast.checked > 3 && baseline.checks.tapTargets.checked >= 1, `the checks measured the page:\n${summary(baseline)}`);
  const ours = findings;

  step('each defect is reported on the element to change');
  const style = (nodeId, property, value, extra = {}) => ({ type: 'node.setStyle', owner, nodeId, scope: 'phone', property, value, ...extra });
  await apply(
    [
      style(grid, 'color', '#d9d9d9', { partId: 'cardTitle', itemId: card }),
      style(storyBox, 'height', '48px'),
      style(storyBox, 'overflow', 'hidden'),
      style(panels, 'layout', 'grid'),
      style(panels, 'columns', 2),
      style(wide, 'width', '320px'),
      style(button, 'height', '28px'),
      style(button, 'minHeight', '0px')
    ],
    'Break the page'
  );
  const broken = await inspectUntil((r) => assert.deepEqual(ours(r).map((i) => i.kind).sort(), ['clipped-text', 'low-contrast', 'overlap', 'small-tap-target']), 'every defect reported');
  const one = (kind) => ours(broken).find((i) => i.kind === kind);
  // The second card's title, as node.setStyle addresses it: the placement, its part and that one card.
  assert.deepEqual(one('low-contrast').ref, { owner, nodeId: grid, partId: 'cardTitle', itemId: card }, summary(broken));
  assert.ok(one('low-contrast').ratio < 4.5);
  assert.deepEqual(one('clipped-text').ref, { owner, nodeId: storyBox }, summary(broken));
  assert.deepEqual([one('overlap').ref, one('overlap').with.ref], [{ owner, nodeId: wide }, { owner, nodeId: next }], summary(broken));
  assert.deepEqual(one('small-tap-target').ref, { owner, nodeId: button }, summary(broken));
  assert.deepEqual(
    Object.fromEntries(Object.entries(broken.checks).map(([k, c]) => [k, c.failed])),
    { contrast: 1, overlaps: 1, clippedText: 1, tapTargets: 1 },
    summary(broken)
  );

  step('fixed through the references it gave, the page reports nothing again');
  const fix = (f, property) => ({ type: 'node.setStyle', owner: f.ref.owner, nodeId: f.ref.nodeId, ...(f.ref.partId ? { partId: f.ref.partId } : {}), ...(f.ref.itemId ? { itemId: f.ref.itemId } : {}), scope: 'phone', property, value: null });
  await apply(
    [fix(one('low-contrast'), 'color'), fix(one('clipped-text'), 'height'), fix(one('clipped-text'), 'overflow'), fix(one('overlap'), 'width'), fix(one('small-tap-target'), 'height'), fix(one('small-tap-target'), 'minHeight')],
    'Fix the page'
  );
  const fixed = await inspectUntil((r) => assert.deepEqual(findings(r), []), 'the fixed page is clean');
  for (const [name, c] of Object.entries(fixed.checks)) assert.deepEqual([c.failed, c.unverified, c.incomplete], [0, 0, undefined], `${name} is clean again:\n${summary(fixed)}`);

  assert.deepEqual(errors, [], 'no page errors');
} finally {
  await app.close();
}
// Only once the app has closed: it writes to its folder until then.
cleanup();
console.log('\ninspect-layout: all checks passed');
