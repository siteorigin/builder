// The pure half of the test driver's UI observations (tests/driver/snapshot.ts, issue #492): redaction, shaping,
// bounding, finding, context and refs, on Playwright-shaped trees, plus the operations' argument checks.
import { describe, expect, it } from 'vitest';
import { parseLocateArgs, parseSnapshotArgs, semanticSelector } from '../driver/observe.ts';
import { DriverError } from '../driver/protocol.ts';
import {
  REDACTED,
  RefRegistry,
  choose,
  describe as describeNode,
  dialogFrom,
  find,
  findByPwRef,
  focusFrom,
  modeFrom,
  redact,
  regionNodes,
  render,
  rootsLeft,
  selectionToolbar,
  shape,
  valueRefs,
  walk
} from '../driver/snapshot.ts';
import type { ElementFacts, RawNode, Shaped } from '../driver/snapshot.ts';

const none = { secretRefs: new Set<string>(), unknownRefs: new Set<string>(), secrets: [] as string[] };
const json = (v: unknown) => JSON.stringify(v);

function settingsTree(): RawNode[] {
  return [
    {
      role: 'dialog',
      name: 'Settings',
      ref: 'e1',
      children: [
        { role: 'textbox', name: 'API key', ref: 'e2', text: 'sk-SECRET-123456' },
        { role: 'status', ref: 'e3', text: 'Saved sk-SECRET-123456 for later' },
        { role: 'textbox', name: 'Title', ref: 'e4', text: 'Home' },
        { role: 'generic', ref: 'e5', children: ['Typed sk-SECRET-123456'] }
      ]
    }
  ];
}

describe('redaction', () => {
  it('finds every field that holds a value, to classify it', () => {
    expect(valueRefs(settingsTree())).toEqual(['e2', 'e4']);
    expect(valueRefs([{ role: 'spinbutton', ref: 's1', children: ['1280'] }, { role: 'textbox', ref: 's2' }])).toEqual(['s1']);
  });

  it('removes a secret field’s value and every echo of it, even one the page reads missed', () => {
    // The page reads saw no secret (it was typed between them); the captured value is what is scrubbed.
    const tree = redact(settingsTree(), { ...none, secretRefs: new Set(['e2']) });
    expect(json(tree)).not.toContain('SECRET');
    const [dialog] = shape(tree, 'editor');
    const [key, status, title] = dialog.children;
    expect(key).toMatchObject({ role: 'textbox', name: 'API key', redacted: true });
    expect(key.value).toBeUndefined();
    expect(status.text).toBe(`Saved ${REDACTED} for later`);
    expect(title.value).toBe('Home');
    expect(json(shape(tree, 'editor'))).toContain(REDACTED);
  });

  it('removes the value of a field it could not classify, or one with no ref', () => {
    const tree = redact([{ role: 'textbox', name: 'A', ref: 'a', text: 'x1' }, { role: 'searchbox', name: 'B', text: 'x2' }, { role: 'textbox', name: 'C', ref: 'c', text: 'kept' }], { ...none, unknownRefs: new Set(['a']) });
    const shaped = shape(tree, 'editor');
    expect(shaped.map((n) => [n.name, n.value, n.redacted])).toEqual([
      ['A', undefined, true],
      ['B', undefined, true],
      ['C', 'kept', undefined]
    ]);
  });

  it('scrubs secrets read from the page wherever they appear, but a short one only as a whole value', () => {
    const tree = redact(
      [
        { role: 'paragraph', ref: 'p', text: 'the hunter2 key', name: 'about hunter2' },
        { role: 'paragraph', ref: 'q', text: 'abc and abcdef' },
        { role: 'paragraph', ref: 'r', text: 'abc' }
      ],
      { ...none, secrets: ['hunter2', 'abc'] }
    );
    expect(tree.map((n) => (typeof n === 'string' ? n : [n.name, n.text]))).toEqual([
      [`about ${REDACTED}`, `the ${REDACTED} key`],
      [undefined, 'abc and abcdef'],
      [undefined, REDACTED]
    ]);
  });
});

describe('shaping', () => {
  const raw: RawNode[] = [
    {
      role: 'generic',
      ref: 'g0',
      children: [
        { role: 'toolbar', name: 'Panels', ref: 't1', children: [{ role: 'button', name: 'Pages', ref: 'b1', pressed: true }] },
        { role: 'generic', ariaHidden: true, ref: 'h1', text: '/' },
        { role: 'generic', ref: 'g1', children: [{ role: 'button', name: 'Undo', ref: 'b2', disabled: true }, 'px'] },
        { role: 'combobox', name: 'Image', ref: 'c1', children: [{ role: 'option', name: 'None', ref: 'o1', selected: true }] },
        { role: 'spinbutton', name: 'Width', ref: 's1', text: '1280' },
        { role: 'main', name: 'Website preview', ref: 'm1', children: [{ role: 'iframe', ref: 'i1', children: [{ role: 'heading', name: 'Inside', ref: 'f2e1' }] }] }
      ]
    }
  ];

  it('folds the editor’s unnamed wrappers and drops what assistive technology does not see', () => {
    const roots = shape(raw, 'editor');
    expect(roots.map((n) => n.role)).toEqual(['toolbar', 'button', 'text', 'combobox', 'spinbutton', 'main']);
    expect(roots[0].children[0]).toMatchObject({ role: 'button', name: 'Pages', pressed: true, regions: ['toolbar "Panels"'], pwRef: 'b1' });
    expect(roots[1]).toMatchObject({ name: 'Undo', disabled: true });
    expect(roots[2]).toMatchObject({ role: 'text', text: 'px' });
    expect(json(roots)).not.toContain('"h1"');
  });

  it('keeps the site’s wrappers in the preview: they are its structure', () => {
    const roots = shape(raw, 'preview');
    expect(roots[0]).toMatchObject({ role: 'generic', pwRef: 'g0' });
    expect(roots[0].children.map((n) => n.role)).toContain('generic');
  });

  it('reports a field’s text as its value and keeps a combobox’s options as children', () => {
    const roots = shape(raw, 'editor');
    expect(roots[3]).toMatchObject({ role: 'combobox', name: 'Image' });
    expect(roots[3].value).toBeUndefined();
    expect(roots[3].children[0]).toMatchObject({ role: 'option', name: 'None', selected: true });
    expect(roots[4]).toMatchObject({ role: 'spinbutton', value: '1280' });
  });

  it('stops at an iframe: its document is a scope of its own', () => {
    const main = shape(raw, 'editor')[5];
    expect(main.children).toEqual([expect.objectContaining({ role: 'iframe', pwRef: 'i1', children: [], regions: ['main "Website preview"'] })]);
    expect(main.size).toBe(1);
  });

  it('clips long strings', () => {
    const [n] = shape([{ role: 'heading', name: 'x'.repeat(500), ref: 'h', text: 'y'.repeat(900) }], 'preview');
    expect(n.name!.length).toBe(200);
    expect(n.name!.endsWith('…')).toBe(true);
    expect(n.text!.length).toBe(300);
  });
});

/** A list of `count` items, each with one child. */
function list(count: number): Shaped[] {
  return shape(
    [{ role: 'list', name: 'Items', ref: 'L', children: Array.from({ length: count }, (_, i) => ({ role: 'listitem', ref: `i${i}`, children: [{ role: 'link', name: `Item ${i}`, ref: `l${i}` }] })) }],
    'preview'
  );
}

describe('bounding', () => {
  const opts = (shown: Set<Shaped>) => ({ shown, refFor: (n: Shaped) => `r:${n.pwRef}`, facts: new Map(), viewports: {} });

  it('fills the budget breadth first, so the top of the tree shows before any depth', () => {
    const roots = list(5);
    const shown = choose(roots, { maxNodes: 4 });
    expect([...shown].map((n) => n.pwRef)).toEqual(['L', 'i0', 'i1', 'i2']);
    const [L] = render(roots, opts(shown));
    expect(L.children!.map((c) => c.ref)).toEqual(['r:i0', 'r:i1', 'r:i2']);
    // What was left out says how much and where to continue.
    expect(L.more).toEqual({ children: 2, nodes: 4, continue: { within: 'r:L', offset: 3 } });
    expect(L.children![0].more).toEqual({ children: 1, nodes: 1, continue: { within: 'r:i0', offset: 0 } });
  });

  it('continues from an offset with the rest of the children', () => {
    const roots = list(5);
    const rest = roots[0].children.slice(3);
    const shown = choose(rest, { maxNodes: 100 });
    expect(render(rest, opts(shown)).map((n) => n.ref)).toEqual(['r:i3', 'r:i4']);
  });

  it('stops at a depth', () => {
    const roots = list(2);
    const shown = choose(roots, { maxNodes: 100, depth: 1 });
    expect(shown.size).toBe(3);
    expect(render(roots, opts(shown))[0].children![0].more).toMatchObject({ children: 1 });
  });

  it('reports top-level nodes left out', () => {
    const roots = [...list(1), ...list(1)];
    const shown = choose(roots, { maxNodes: 1 });
    expect(rootsLeft(roots, shown)).toEqual({ children: 1, nodes: 3 });
    expect(rootsLeft(roots, choose(roots, { maxNodes: 10 }))).toBeNull();
  });

  it('marks what is out of view, blocked by a dialog, or carries the page’s ids', () => {
    const [n] = shape([{ role: 'link', name: 'Footer', ref: 'f', box: { x: 10, y: 1400.4, width: 50.2, height: 20 } }], 'preview');
    const facts = new Map<Shaped, ElementFacts>([[n, { secret: false, blocked: true, semantic: { ctx: 'page:p|n', node: 'link' } }]]);
    const d = describeNode(n, { refFor: () => 'r1', facts, viewports: { preview: { width: 1280, height: 900 } } });
    expect(d).toEqual({ role: 'link', name: 'Footer', ref: 'r1', box: { x: 10, y: 1400, width: 50, height: 20 }, offscreen: true, blocked: true, semantic: { ctx: 'page:p|n', node: 'link' } });
    expect(describeNode(n, { refFor: () => null, facts: new Map(), viewports: { preview: { width: 1280, height: 2000 } } })).not.toHaveProperty('offscreen');
  });
});

describe('finding and context', () => {
  const page = shape(
    [
      { role: 'banner', ref: 'b', children: [{ role: 'navigation', name: 'Main', ref: 'n1', children: [{ role: 'link', name: 'About', ref: 'a1' }] }] },
      { role: 'contentinfo', ref: 'c', children: [{ role: 'navigation', name: 'Explore', ref: 'n2', children: [{ role: 'link', name: 'About  ', ref: 'a2' }, { role: 'link', name: 'About the studio', ref: 'a3' }] }] }
    ],
    'preview'
  );

  it('tells similarly named controls apart by region', () => {
    expect(find(page, { role: 'link', name: 'About' }).map((n) => n.pwRef)).toEqual(['a1', 'a2']);
    expect(find(page, { role: 'link', name: 'About', region: 'contentinfo' }).map((n) => n.pwRef)).toEqual(['a2']);
    expect(find(page, { role: 'link', name: 'About', region: 'main' }).map((n) => n.pwRef)).toEqual(['a1']);
    expect(find(page, { role: 'link', name: 'about', exact: false }).map((n) => n.pwRef)).toEqual(['a1', 'a2', 'a3']);
    expect(find(page, { role: 'link', name: 'About', region: 'navigation "Explore"' }).map((n) => n.regions)).toEqual([['contentinfo', 'navigation "Explore"']]);
  });

  it('finds regions to search in, outermost only', () => {
    expect(regionNodes(page, 'navigation').map((n) => n.pwRef)).toEqual(['n1', 'n2']);
    expect(regionNodes(page, 'contentinfo').map((n) => n.pwRef)).toEqual(['c']);
    expect(regionNodes(page, 'nothing')).toEqual([]);
  });

  it('reads the mode, the topmost dialog, focus and the selection toolbar from the editor', () => {
    const editor = shape(
      [
        { role: 'group', name: 'Mode', ref: 'm', children: [{ role: 'button', name: 'Edit', ref: 'e' }, { role: 'button', name: 'Preview', ref: 'p', pressed: true }] },
        { role: 'main', name: 'Website preview', ref: 'w', children: [{ role: 'toolbar', name: 'Split hero actions', ref: 't', children: [{ role: 'button', name: 'Move up', ref: 'u', active: true }] }] },
        { role: 'dialog', name: 'Settings', ref: 'd1' },
        { role: 'alertdialog', name: 'Discard?', ref: 'd2' }
      ],
      'editor'
    );
    expect(modeFrom(editor)).toBe('preview');
    expect(dialogFrom(editor)?.name).toBe('Discard?');
    expect(focusFrom(editor)?.name).toBe('Move up');
    expect(selectionToolbar(editor)?.name).toBe('Split hero actions');
    expect(modeFrom(shape([{ role: 'button', name: 'Edit', ref: 'x', pressed: true }], 'editor'))).toBeNull();
    expect(findByPwRef(editor, 'u')?.name).toBe('Move up');
    expect([...walk(editor)].length).toBe(8);
  });
});

describe('refs', () => {
  const base = { generation: 1, scope: 'preview' as const, opening: '/p#1', doc: '100.5|/', pwRef: 'f3e24', role: 'heading', name: 'Calm', semantic: null };

  it('gives the same element in the same document the same ref, and anything else another', () => {
    const r = new RefRegistry();
    const a = r.mint(base);
    expect(a).toMatch(/^[0-9a-f]{4}:\d+$/);
    expect(r.mint({ ...base })).toBe(a);
    expect(r.mint({ ...base, doc: '200.1|/' })).not.toBe(a);
    expect(r.mint({ ...base, generation: 2 })).not.toBe(a);
    expect(r.mint({ ...base, opening: '/p#2' })).not.toBe(a);
    expect(r.get(a)).toMatchObject({ ...base, token: a });
  });

  it('forgets the oldest past its limit, and everything when cleared', () => {
    const r = new RefRegistry(3);
    const first = r.mint({ ...base, pwRef: 'e1' });
    for (const p of ['e2', 'e3', 'e4']) r.mint({ ...base, pwRef: p });
    expect(r.size).toBe(3);
    expect(r.get(first)).toBeNull();
    // A forgotten element gets a new ref when seen again.
    expect(r.mint({ ...base, pwRef: 'e1' })).not.toBe(first);
    r.clear();
    expect(r.size).toBe(0);
  });

  it('never hands one session’s ref to another', () => {
    const a = new RefRegistry().mint(base);
    const b = new RefRegistry();
    b.mint(base);
    expect(b.get(a)).toBeNull();
  });
});

describe('arguments', () => {
  const refused = (f: () => unknown) => {
    try {
      f();
    } catch (e) {
      return e instanceof DriverError ? e.code : 'other';
    }
    return 'accepted';
  };

  it('ui.snapshot takes a scope, or a ref to look inside, and bounds', () => {
    expect(parseSnapshotArgs({})).toEqual({ scope: 'all' });
    expect(parseSnapshotArgs({ within: 'ab12:3', offset: 4, maxNodes: 50, depth: 2, screenshot: true })).toMatchObject({ within: 'ab12:3', offset: 4, maxNodes: 50, depth: 2, screenshot: true });
    expect(refused(() => parseSnapshotArgs({ scope: 'site' }))).toBe('BAD_REQUEST');
    expect(refused(() => parseSnapshotArgs({ within: 'e12' }))).toBe('BAD_REQUEST');
    expect(refused(() => parseSnapshotArgs({ within: 'ab12:3', scope: 'editor' }))).toBe('BAD_REQUEST');
    expect(refused(() => parseSnapshotArgs({ offset: 2 }))).toBe('BAD_REQUEST');
    expect(refused(() => parseSnapshotArgs({ maxNodes: 1001 }))).toBe('BAD_REQUEST');
    expect(refused(() => parseSnapshotArgs({ maxNodes: 0 }))).toBe('BAD_REQUEST');
    expect(refused(() => parseSnapshotArgs({ screenshot: 'yes' }))).toBe('BAD_REQUEST');
    expect(refused(() => parseSnapshotArgs({ selector: 'h1' }))).toBe('BAD_REQUEST');
  });

  it('ui.locate takes a ref alone, or a role with a name, region or ref to search in', () => {
    expect(parseLocateArgs({ ref: 'ab12:3' })).toEqual({ ref: 'ab12:3' });
    expect(parseLocateArgs({ role: 'link', name: 'About', region: 'contentinfo' })).toEqual({ role: 'link', name: 'About', region: 'contentinfo', scope: 'all' });
    expect(parseLocateArgs({ role: 'button', within: 'ab12:9', exact: false, name: 'edit' })).toMatchObject({ within: 'ab12:9', exact: false });
    expect(refused(() => parseLocateArgs({}))).toBe('BAD_REQUEST');
    expect(refused(() => parseLocateArgs({ ref: 'ab12:3', role: 'button' }))).toBe('BAD_REQUEST');
    expect(refused(() => parseLocateArgs({ role: 'Button!' }))).toBe('BAD_REQUEST');
    expect(refused(() => parseLocateArgs({ role: 'link', region: 'x', within: 'ab12:1' }))).toBe('BAD_REQUEST');
    expect(refused(() => parseLocateArgs({ role: 'link', within: 'ab12:1', scope: 'preview' }))).toBe('BAD_REQUEST');
    expect(refused(() => parseLocateArgs({ role: 'link', name: ' ' }))).toBe('BAD_REQUEST');
  });

  it('finds the page’s elements by their ids as the bridge does, quoting what needs it', () => {
    expect(semanticSelector({ ctx: 'page:p1|n_2', node: 'heading' })).toBe('[data-so-ctx="page:p1|n_2"][data-so-node="heading"]');
    expect(semanticSelector({ ctx: 'a"b\\c', node: 'n', items: 'i1,i2' })).toBe('[data-so-ctx="a\\"b\\\\c"][data-so-node="n"][data-so-items="i1,i2"]');
  });
});
